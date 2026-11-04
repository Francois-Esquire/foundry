import type { ArtifactResolved } from "@foundry/artifacts";
import type { ArtifactModuleStore } from "@foundry/modules/store/artifact";
import type { ExecutionRun, TaskContext } from "@foundry.sh/marbles/engine";
import { WORKS_TASKS } from "~/shared/execution";
import {
  OBSERVATION,
  type SourceSaveEvidence,
  savedEvidence,
} from "~/shared/observations";
import { observeResult, type WorksExecution } from "./contract";

/** One Module source save or release, as the library asks for it. */
export type SourceSave =
  /** Source saved by a person, or picked up from disk edits. */
  | {
      readonly actor: "disk" | "user";
      readonly kind: "source";
      readonly moduleId: string;
    }
  /** A release, published by the build run that built it. */
  | {
      readonly actor: "build";
      readonly builtBy: string;
      readonly kind: "release";
      readonly moduleId: string;
    };

/**
 * The latest source or release save's attribution, stamped on the Module's
 * Content (`origin`) in the same write. It names the run that made it, so a
 * result that run could not record can be recorded again later.
 */
export interface SourceOrigin {
  readonly actor: SourceSave["actor"];
  readonly at: string;
  readonly kind: SourceSave["kind"];
  /** The build run a release came from. */
  readonly parentRunId?: string;
  readonly runId: string;
}

/** What a save's commit hands back: its value, and the Content it saved. */
export interface SourceCommit<T> {
  readonly saved: Pick<
    SourceSaveEvidence,
    "artifactId" | "contentId" | "tag" | "updatedAt"
  >;
  readonly value: T;
}

/**
 * How the Module library commits source saves and releases (spec §4): each
 * is a `system` run that commits with its origin stamped and records its
 * result. Admission is separate because it belongs where the library
 * orders its saves: inside the Module's turn, right before the commit.
 */
export interface SourceSaves {
  /**
   * Right before a save commits: reconcile the Module's latest save,
   * recording its missing result. Throws {@link SourceEvidenceRequired}
   * when the run store cannot record it yet, and any other failure as it is.
   */
  admit(moduleId: string): Promise<void>;
  /** Run `save` as a `system` run: `commit` writes with the origin to stamp. */
  run<T>(
    save: SourceSave,
    commit: (origin: SourceOrigin) => Promise<SourceCommit<T>>
  ): Promise<T>;
}

/** A Module whose last save's result is not on record yet. */
export class SourceEvidenceRequired extends Error {
  override readonly name = "SourceEvidenceRequired";

  constructor() {
    super(
      "This module's last save was made, but Works could not record it yet. Works tries again before each save; try saving again shortly."
    );
  }
}

export interface SourceEvidenceOptions {
  readonly execution: Pick<WorksExecution, "dispatch" | "runs">;
  /** The Module records, read for the origin each Module's latest save stamped. */
  readonly modules: Pick<ArtifactModuleStore, "moduleArtifacts">;
}

/**
 * Save evidence for Module source and releases (spec §4), the counterpart of
 * product files' recovery: each save stamps its origin in the write; a save
 * whose run result could not be recorded blocks the Module's next save until
 * that result is recorded from the origin. At startup (and before a
 * Module's first save in a process) the latest save is reconciled the same
 * way.
 */
export class SourceEvidence implements SourceSaves {
  /** Modules whose latest save's result is missing. */
  readonly #blocked = new Set<string>();
  /** Modules reconciled against the run store this process loaded. */
  readonly #checked = new Set<string>();
  readonly #execution: SourceEvidenceOptions["execution"];
  readonly #modules: SourceEvidenceOptions["modules"];

  constructor(options: SourceEvidenceOptions) {
    this.#execution = options.execution;
    this.#modules = options.modules;
  }

  async admit(moduleId: string): Promise<void> {
    if (this.#checked.has(moduleId) && !this.#blocked.has(moduleId)) {
      return;
    }
    const artifact = (await this.#modules.moduleArtifacts()).find(
      (candidate) => candidate.metadata.moduleId === moduleId
    );
    await this.#admit(moduleId, artifact);
  }

  run<T>(
    save: SourceSave,
    commit: (origin: SourceOrigin) => Promise<SourceCommit<T>>
  ): Promise<T> {
    const { actor, kind, moduleId } = save;
    const parentRunId = save.actor === "build" ? save.builtBy : undefined;
    const task = {
      build: WORKS_TASKS.publish,
      disk: WORKS_TASKS.sourceSync,
      user: WORKS_TASKS.save,
    }[actor];
    return this.#execution.dispatch(
      task,
      {
        correlation: {
          moduleId,
          ...(parentRunId === undefined ? {} : { parentRunId }),
        },
      },
      async (context) => {
        const { saved, value } = await commit({
          actor,
          at: new Date().toISOString(),
          kind,
          ...(parentRunId === undefined ? {} : { parentRunId }),
          runId: context.run.id,
        });
        this.#record(context, {
          actor,
          artifactId: saved.artifactId,
          contentId: saved.contentId,
          kind,
          moduleId,
          ...(saved.tag === undefined ? {} : { tag: saved.tag }),
          updatedAt: saved.updatedAt,
        });
        return value;
      }
    );
  }

  /**
   * At startup: reconcile every Module's latest save. Returns the Modules
   * that could not be, and why, for the caller to report; each stays
   * blocked or unchecked, so its next save tries again.
   */
  async recoverAll(): Promise<
    readonly { readonly error: unknown; readonly moduleId: string }[]
  > {
    const failures: { error: unknown; moduleId: string }[] = [];
    for (const artifact of await this.#modules.moduleArtifacts()) {
      const { moduleId } = artifact.metadata;
      if (typeof moduleId !== "string") {
        continue;
      }
      try {
        await this.#admit(moduleId, artifact);
      } catch (error) {
        failures.push({ error, moduleId });
      }
    }
    return failures;
  }

  /** Record a committed save on its run; a result that is not kept blocks the Module. */
  #record(context: TaskContext, save: SourceSaveEvidence): void {
    if (!observeResult(context, OBSERVATION.save, save)) {
      this.#blocked.add(save.moduleId);
    }
  }

  async #admit(
    moduleId: string,
    artifact: ArtifactResolved | undefined
  ): Promise<void> {
    if (!(await this.#reconcile(moduleId, artifact))) {
      this.#blocked.add(moduleId);
      throw new SourceEvidenceRequired();
    }
    this.#blocked.delete(moduleId);
    this.#checked.add(moduleId);
  }

  /**
   * Whether the Module's latest save has its result on record, recording it
   * when missing. False only when the run store would not take the record;
   * anything else that fails is a fault and is thrown.
   */
  async #reconcile(
    moduleId: string,
    artifact: ArtifactResolved | undefined
  ): Promise<boolean> {
    const content = artifact?.content;
    const origin = content ? sourceOriginOf(content.metadata) : null;
    if (!(artifact && content && origin)) {
      return true;
    }
    // A run of this process keeps an unrecorded result in memory, so a
    // blocked Module is always recovered rather than looked up.
    if (!this.#blocked.has(moduleId) && this.#recorded(origin)) {
      return true;
    }
    const evidence: SourceSaveEvidence = {
      actor: origin.actor,
      artifactId: artifact.id,
      contentId: content.id,
      kind: origin.kind,
      moduleId,
      recoveredFrom: origin.runId,
      ...(content.tag ? { tag: content.tag } : {}),
      updatedAt: content.updatedAt.toISOString(),
    };
    try {
      return await this.#execution.dispatch(
        WORKS_TASKS.sourceRecover,
        { correlation: { moduleId } },
        (context) => observeResult(context, OBSERVATION.save, evidence)
      );
    } catch {
      // The run store refused the recovery run: try again later.
      return false;
    }
  }

  /** Whether the run store holds the result of the save `origin` names. */
  #recorded(origin: SourceOrigin): boolean {
    const made = this.#execution.runs.get(origin.runId);
    if (made && savesOf(made).length > 0) {
      return true;
    }
    return this.#execution.runs
      .list()
      .some((run) =>
        savesOf(run).some((save) => save.recoveredFrom === origin.runId)
      );
  }
}

function savesOf(run: ExecutionRun): SourceSaveEvidence[] {
  return run.observations.flatMap((observation) => {
    const evidence = savedEvidence(observation);
    return evidence && evidence.kind !== "file" ? [evidence] : [];
  });
}

const SOURCE_ACTORS: ReadonlySet<unknown> = new Set(["build", "disk", "user"]);

/** The origin a Module's Content carries, if it is well formed. */
function sourceOriginOf(
  metadata: Readonly<Record<string, unknown>>
): SourceOrigin | null {
  const origin = metadata.origin as Partial<SourceOrigin> | undefined;
  return origin &&
    typeof origin.runId === "string" &&
    (origin.kind === "source" || origin.kind === "release") &&
    SOURCE_ACTORS.has(origin.actor)
    ? (origin as SourceOrigin)
    : null;
}
