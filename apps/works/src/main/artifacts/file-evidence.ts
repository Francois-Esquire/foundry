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

export interface FileOrigin {
  readonly actor: FileSaveEvidence["actor"];
  readonly at: string;
  readonly input: string;
  readonly installationId?: string;
  readonly moduleId?: string;
  readonly operation: string;
  readonly path?: string | null;
  readonly runId: string;
  readonly runtimeInstanceId?: string;
}

export interface FileEvidenceOptions {
  readonly artifacts: Pick<Artifacts, "list">;
  readonly execution: Pick<WorksExecution, "dispatch" | "runs">;
  readonly includes: (artifact: ArtifactResolved) => boolean;
  readonly product: (artifactId: string) => Promise<ArtifactResolved | null>;
}

export class FileEvidence {
  readonly #artifacts: FileEvidenceOptions["artifacts"];
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

  block(artifactId: string): void {
    this.#blocked.add(artifactId);
  }

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

  #recover(
    content: ContentResolved | (ArtifactResolved["content"] & object),
    origin: FileOrigin
  ): Promise<boolean> {
    const evidence: FileSaveEvidence = {
      ...evidenceOf(
        content.artifactId,
        content,
        origin,
        savedPath(content, origin)
      ),
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

  #recordedOperations(): Set<string> {
    const operations = new Set<string>();
    for (const run of this.#execution.runs.list()) {
      for (const evidence of fileEvidence(run)) {
        operations.add(evidence.operation);
      }
    }
    return operations;
  }

  pruned(moduleId: string | undefined): boolean {
    const scope = auditScope(moduleId === undefined ? {} : { moduleId });
    return this.#execution.runs.gaps().some((gap) => gap.scope === scope);
  }

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
        savedPath(artifact.content, origin)
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

  async createdBy(operation: string): Promise<FileSaveEvidence | null> {
    for (const { evidence } of this.#answers(operation)) {
      if (evidence && (await this.#product(evidence.artifactId))) {
        return evidence;
      }
    }
    return null;
  }

  *#answers(operation: string) {
    for (const run of this.#execution.runs.list()) {
      if (run.correlation.operation === operation) {
        const [evidence] = fileEvidence(run);
        yield { evidence, run };
      }
    }
  }
}

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

function entryOf(content: Pick<Content, "metadata">): string | null {
  const { entry } = content.metadata;
  return typeof entry === "string" ? entry : null;
}

function savedPath(
  content: Pick<Content, "metadata">,
  origin: FileOrigin
): string | null {
  return origin.path === undefined ? entryOf(content) : origin.path;
}

export function originOf(content: {
  readonly metadata: Readonly<Record<string, unknown>>;
}): FileOrigin | null {
  const origin = content.metadata.origin as Partial<FileOrigin> | undefined;
  return origin &&
    typeof origin.operation === "string" &&
    typeof origin.runId === "string" &&
    typeof origin.input === "string" &&
    typeof origin.actor === "string" &&
    (origin.path === undefined ||
      origin.path === null ||
      typeof origin.path === "string")
    ? (origin as FileOrigin)
    : null;
}

export function fileEvidence(run: ExecutionRun): FileSaveEvidence[] {
  return run.observations.flatMap((observation) => {
    const evidence = fileSaveEvidence(observation);
    return evidence ? [evidence] : [];
  });
}
