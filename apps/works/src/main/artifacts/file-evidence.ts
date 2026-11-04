import type {
  ArtifactCursor,
  ArtifactResolved,
  Artifacts,
  Content,
  ContentResolved,
} from "@foundry/artifacts";
import type { ExecutionRun } from "@foundry.sh/marbles/engine";
import { observeResult, type WorksExecution } from "~/main/execution/contract";
import { auditScope } from "~/main/execution/retention";
import { WORKS_TASKS } from "~/shared/execution";
import {
  type FileSaveEvidence,
  fileSaveEvidence,
  OBSERVATION,
} from "~/shared/observations";

/**
 * The latest write's attribution, stamped on Content metadata (`origin`) in
 * the same transaction as the write. It names no user-supplied identity, key
 * or prompt.
 */
export interface FileOrigin {
  readonly actor: FileSaveEvidence["actor"];
  readonly at: string;
  readonly input: string;
  readonly installationId?: string;
  readonly moduleId?: string;
  readonly operation: string;
  /** The engine run that made the write. */
  readonly runId: string;
  readonly runtimeInstanceId?: string;
}

export interface FileEvidenceOptions {
  readonly artifacts: Pick<Artifacts, "list">;
  readonly execution: Pick<WorksExecution, "dispatch" | "runs">;
  /** Whether an Artifact is a product file. */
  readonly includes: (artifact: ArtifactResolved) => boolean;
  /** The File Artifact by id; null for anything that is not a product file. */
  readonly product: (artifactId: string) => Promise<ArtifactResolved | null>;
}

/**
 * The evidence of File Artifact writes: each write's result on its run,
 * found again by operation for a retry, and recovered from the Content's
 * origin when a write committed but its result could not be recorded. A
 * File Artifact whose latest result is missing is blocked from the next
 * write until it is recovered.
 */
export class FileEvidence {
  readonly #artifacts: FileEvidenceOptions["artifacts"];
  /** Artifacts whose latest write has no recorded result yet. */
  readonly #blocked = new Set<string>();
  readonly #execution: FileEvidenceOptions["execution"];
  readonly #includes: FileEvidenceOptions["includes"];
  readonly #product: FileEvidenceOptions["product"];

  constructor(options: FileEvidenceOptions) {
    this.#artifacts = options.artifacts;
    this.#execution = options.execution;
    this.#includes = options.includes;
    this.#product = options.product;
  }

  /** A write committed but its result could not be recorded. */
  block(artifactId: string): void {
    this.#blocked.add(artifactId);
  }

  /**
   * True when the Artifact may be written: its latest write's result is on
   * record, or was recovered from its origin just now.
   */
  async reconcile(artifactId: string): Promise<boolean> {
    if (!this.#blocked.has(artifactId)) {
      return true;
    }
    const artifact = await this.#product(artifactId);
    const origin = artifact?.content ? originOf(artifact.content) : null;
    if (!(artifact?.content && origin)) {
      this.#blocked.delete(artifactId);
      return true;
    }
    if (await this.#recover(artifact.content, origin)) {
      this.#blocked.delete(artifactId);
      return true;
    }
    return false;
  }

  /**
   * At startup, before any write: the latest write of each File Artifact
   * whose result is missing from the run store is recorded again from its
   * origin. Only that latest write can be recovered.
   */
  async recoverAll(): Promise<void> {
    const recorded = this.#recordedOperations();
    let cursor: ArtifactCursor | undefined;
    do {
      const page = await this.#artifacts.list(cursor ? { cursor } : {});
      for (const artifact of page.items) {
        const origin = artifact.content ? originOf(artifact.content) : null;
        if (
          artifact.content &&
          origin &&
          this.#includes(artifact) &&
          !recorded.has(origin.operation)
        ) {
          const recovered = await this.#recover(artifact.content, origin).catch(
            () => false
          );
          if (!recovered) {
            this.#blocked.add(artifact.id);
          }
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  /** Record the missing result of the latest write as a recovery run. */
  #recover(
    content: ContentResolved | (ArtifactResolved["content"] & object),
    origin: FileOrigin
  ): Promise<boolean> {
    const evidence: FileSaveEvidence = {
      ...evidenceOf(content.artifactId, content, origin, entryOf(content)),
      recoveredFrom: origin.runId,
    };
    return this.#execution.dispatch(
      WORKS_TASKS.fileRecover,
      {
        correlation: {
          artifactId: content.artifactId,
          operation: origin.operation,
        },
      },
      (context) => observeResult(context, OBSERVATION.save, evidence)
    );
  }

  /** Every operation whose save or create result the run store holds. */
  #recordedOperations(): Set<string> {
    const operations = new Set<string>();
    for (const run of this.#execution.runs.list()) {
      for (const evidence of fileEvidence(run)) {
        operations.add(evidence.operation);
      }
    }
    return operations;
  }

  /**
   * Whether retention has removed runs of a writer's scope: a Module's, or
   * the host's when `moduleId` is unset. Until it has, the run store holds
   * every committed write's result (a missing one blocks the Artifact until
   * it is recovered), so a retry nothing vouches for never committed.
   */
  pruned(moduleId: string | undefined): boolean {
    const scope = auditScope(moduleId === undefined ? {} : { moduleId });
    return this.#execution.runs.gaps().some((gap) => gap.scope === scope);
  }

  /**
   * A committed earlier save of `operation`: the latest origin, else the
   * retained run store. A retry nobody can vouch for is `uncertain` when
   * retention may have removed its evidence (`retryPruned`), as is one
   * whose run ended without saying whether it saved.
   */
  async savedBy(
    artifactId: string,
    operation: string,
    retryPruned: boolean
  ): Promise<FileSaveEvidence | "uncertain" | null> {
    const artifact = await this.#product(artifactId);
    const origin = artifact?.content ? originOf(artifact.content) : null;
    if (artifact?.content && origin?.operation === operation) {
      return evidenceOf(
        artifact.id,
        artifact.content,
        origin,
        entryOf(artifact.content)
      );
    }
    let unsettled = false;
    for (const { evidence, run } of this.#answers(operation)) {
      if (evidence) {
        return evidence;
      }
      unsettled ||= run.status === "interrupted" || run.status === "running";
    }
    return unsettled || retryPruned ? "uncertain" : null;
  }

  /** The Artifact an earlier create of `operation` made, if any. */
  async createdBy(operation: string): Promise<FileSaveEvidence | null> {
    for (const { evidence } of this.#answers(operation)) {
      if (evidence && (await this.#product(evidence.artifactId))) {
        return evidence;
      }
    }
    return null;
  }

  /** Retained runs that answered `operation`, each with its file evidence. */
  *#answers(operation: string) {
    for (const run of this.#execution.runs.list()) {
      if (run.correlation.operation === operation) {
        const [evidence] = fileEvidence(run);
        yield { evidence, run };
      }
    }
  }
}

/**
 * A write's evidence from its Content and origin: the written entry's digest
 * and size, or the whole tree's when no single entry was written.
 */
export function evidenceOf(
  artifactId: string,
  content: Pick<Content, "digest" | "id" | "tree" | "updatedAt">,
  origin: FileOrigin,
  path: string | null
): FileSaveEvidence {
  const node = path === null ? undefined : content.tree[path];
  const file = node?.type === "file" ? node : null;
  return {
    actor: origin.actor,
    artifactId,
    bytes: file
      ? file.bytes
      : Object.values(content.tree).reduce(
          (sum, entry) => sum + (entry.type === "file" ? entry.bytes : 0),
          0
        ),
    contentId: content.id,
    digest: file ? file.digest : content.digest,
    input: origin.input,
    kind: "file",
    ...(origin.moduleId === undefined ? {} : { moduleId: origin.moduleId }),
    operation: origin.operation,
    path: file ? path : null,
    updatedAt: content.updatedAt.toISOString(),
  };
}

/** The primary entry a Content declares, if any. */
function entryOf(content: Pick<Content, "metadata">): string | null {
  const { entry } = content.metadata;
  return typeof entry === "string" ? entry : null;
}

/** The origin a File Artifact's Content carries, if it is well formed. */
export function originOf(content: {
  readonly metadata: Readonly<Record<string, unknown>>;
}): FileOrigin | null {
  const origin = content.metadata.origin as Partial<FileOrigin> | undefined;
  return origin &&
    typeof origin.operation === "string" &&
    typeof origin.runId === "string" &&
    typeof origin.input === "string" &&
    typeof origin.actor === "string"
    ? (origin as FileOrigin)
    : null;
}

/** The File Artifact save/create results a run recorded. */
export function fileEvidence(run: ExecutionRun): FileSaveEvidence[] {
  return run.observations.flatMap((observation) => {
    const evidence = fileSaveEvidence(observation);
    return evidence ? [evidence] : [];
  });
}
