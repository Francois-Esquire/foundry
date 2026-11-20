import type { ArtifactResolved } from "@foundry/artifacts";
import { KeyedTurns } from "@foundry/modules/platform/turns";
import type { ExecutionRun, TaskContext } from "@foundry.sh/marbles/engine";
import type { ArtifactModuleStore } from "~/main/modules/store/artifact";
import { WORKS_TASKS } from "~/shared/execution";
import {
  OBSERVATION,
  type SourceSaveEvidence,
  savedEvidence,
} from "~/shared/observations";
import { observeResult, type WorksExecution } from "./contract";

export type SourceSave =
  | {
      readonly actor: "disk" | "user";
      readonly kind: "source";
      readonly moduleId: string;
    }
  | {
      readonly actor: "build";
      readonly builtBy: string;
      readonly kind: "release";
      readonly moduleId: string;
    };

export interface SourceOrigin {
  readonly actor: SourceSave["actor"];
  readonly at: string;
  readonly kind: SourceSave["kind"];
  readonly parentRunId?: string;
  readonly runId: string;
}

interface SourceCommit<T> {
  readonly saved: Pick<
    SourceSaveEvidence,
    "artifactId" | "contentId" | "tag" | "updatedAt"
  >;
  readonly value: T;
}

export type SourceCommitter<T> = (
  origin: SourceOrigin,
  committed: (saved: SourceCommit<T>["saved"]) => void
) => Promise<SourceCommit<T>>;

export interface SourceSaves {
  admit(moduleId: string): Promise<void>;
  run<T>(save: SourceSave, commit: SourceCommitter<T>): Promise<T>;
}

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
  readonly modules: Pick<ArtifactModuleStore, "moduleArtifacts">;
}

export class SourceEvidence implements SourceSaves {
  readonly #turns = new KeyedTurns();
  readonly #blocked = new Set<string>();
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

  run<T>(save: SourceSave, commit: SourceCommitter<T>): Promise<T> {
    const { actor, kind, moduleId } = save;
    const parentRunId = save.actor === "build" ? save.builtBy : undefined;
    const task = {
      build: WORKS_TASKS.publish,
      disk: WORKS_TASKS.sourceSync,
      user: WORKS_TASKS.save,
    }[actor];
    return this.#turns.run(moduleId, () =>
      this.#execution.dispatch(
        task,
        {
          correlation: {
            moduleId,
            ...(parentRunId === undefined ? {} : { parentRunId }),
          },
        },
        async (context) => {
          let recorded = false;
          let recording: Promise<void> | undefined;
          const record = (saved: SourceCommit<T>["saved"]) => {
            if (recorded) {
              return;
            }
            recorded = true;
            recording = this.#record(context, {
              actor,
              artifactId: saved.artifactId,
              contentId: saved.contentId,
              kind,
              moduleId,
              ...(saved.tag === undefined ? {} : { tag: saved.tag }),
              updatedAt: saved.updatedAt,
            });
          };
          try {
            const { saved, value } = await commit(
              {
                actor,
                at: new Date().toISOString(),
                kind,
                ...(parentRunId === undefined ? {} : { parentRunId }),
                runId: context.run.id,
              },
              record
            );
            record(saved);
            return value;
          } catch (error) {
            if (!recorded) {
              this.#checked.delete(moduleId);
            }
            throw error;
          } finally {
            await recording;
          }
        }
      )
    );
  }

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

  async #record(context: TaskContext, save: SourceSaveEvidence): Promise<void> {
    if (!(await observeResult(context, OBSERVATION.save, save))) {
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

  async #reconcile(
    moduleId: string,
    artifact: ArtifactResolved | undefined
  ): Promise<boolean> {
    const content = artifact?.content;
    const origin = content ? sourceOriginOf(content.metadata) : null;
    if (!(artifact && content && origin)) {
      return true;
    }
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
      return false;
    }
  }

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
