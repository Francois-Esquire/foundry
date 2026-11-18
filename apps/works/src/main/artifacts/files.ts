import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  type ArtifactId,
  type ArtifactOperations,
  type ArtifactResolved,
  type Artifacts,
  artifactIdSchema,
  type ContentId,
  type ContentResolved,
  isUsableContent,
} from "@foundry/artifacts";
import {
  type ArtifactDiskConflict,
  type ArtifactFileSystem,
  artifactFileSystem,
} from "@foundry/artifacts/node";
import { MODULE_MIME } from "@foundry/modules/constants";
import { KeyedTurns } from "@foundry/modules/platform/turns";
import { directory, WorkspaceSystem } from "@foundry/workspaces";
import type { TaskContext } from "@foundry.sh/marbles/engine";
import { observeResult, type WorksExecution } from "~/main/execution/contract";
import { WORKS_TASKS } from "~/shared/execution";
import {
  type FileSaveEvidence,
  OBSERVATION,
  type SaveAttempt,
} from "~/shared/observations";
import { evidenceOf, FileEvidence, type FileOrigin } from "./file-evidence";

export type FileActor =
  | { readonly kind: "user" }
  | {
      readonly installationId: string;
      readonly kind: "module";
      readonly moduleId: string;
      readonly runtimeInstanceId: string;
    };

type WriteActor = FileActor | { readonly kind: "disk" };

export type FileAuthority = (
  operations: ArtifactOperations,
  artifact: ArtifactResolved | null
) => Promise<void>;

export type FileSaveResult =
  | {
      readonly bytes: number;
      readonly contentId: string;
      readonly digest: string;
      readonly evidence: "recorded" | "recovery-required";
      readonly kind: "saved";
      readonly retried: boolean;
      readonly updatedAt: string;
    }
  | {
      readonly current: {
        readonly bytes: number;
        readonly digest: string;
        readonly text: string;
      };
      readonly kind: "conflict";
    }
  | {
      readonly kind: "denied" | "failed" | "refused" | "stale" | "uncertain";
      readonly reason: string;
    };

export interface FileSaveInput {
  readonly actor: FileActor;
  readonly artifactId: string;
  readonly authorize?: FileAuthority;
  readonly expectedDigest: string;
  readonly path: string;
  readonly request?: string;
  readonly retry?: boolean;
  readonly text: string;
}

export interface FileCreateInput {
  readonly actor: FileActor;
  readonly authorize?: FileAuthority;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly name: string;
  readonly path: string;
  readonly request?: string;
}

export type FileCreateResult =
  | {
      readonly artifactId: string;
      readonly bytes: number;
      readonly contentId: string;
      readonly digest: string;
      readonly kind: "created";
      readonly path: string;
      readonly retried: boolean;
      readonly updatedAt: string;
    }
  | {
      readonly kind: "denied" | "refused" | "uncertain";
      readonly reason: string;
    };

export interface FileChunk {
  readonly bytes: number;
  readonly data: Uint8Array;
  readonly digest: string;
  readonly end: number;
  readonly mime: string | null;
  readonly offset: number;
}

export async function readRange(
  artifacts: Pick<ArtifactOperations, "readFileRange">,
  contentId: string,
  path: string,
  range: { readonly end: number; readonly start: number }
): Promise<FileChunk | null> {
  const file = await artifacts.readFileRange(
    contentId as ContentId,
    path,
    range
  );
  if (!file) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of file.body) {
    chunks.push(chunk);
  }
  return {
    bytes: file.bytes,
    data: Buffer.concat(chunks),
    digest: file.digest,
    end: file.range.end,
    mime: file.mime,
    offset: file.range.start,
  };
}

export interface ProductFilesOptions {
  readonly artifacts: Artifacts;
  readonly execution: Pick<WorksExecution, "dispatch" | "runs">;
  readonly onConflict?: (conflict: ArtifactDiskConflict) => void;
  readonly root: string;
}

export function isProductArtifact(artifact: Pick<ArtifactResolved, "type">) {
  return artifact.type !== MODULE_MIME;
}

export class FileWriteDenied extends Error {
  override readonly name = "FileWriteDenied";
}

const EVIDENCE_REQUIRED =
  "This file was saved, but Works could not record that save yet. It will try again before the next save.";

interface WriteScope {
  readonly authorize?: FileAuthority;
  open: boolean;
  readonly origin: FileOrigin;
  refusal?: unknown;
  written?: ContentResolved;
}

export class ProductFiles {
  readonly #artifacts: Artifacts;
  readonly #evidence: FileEvidence;
  readonly #execution: ProductFilesOptions["execution"];
  readonly #filesystem: ArtifactFileSystem;
  readonly #ready: Promise<void>;
  readonly #scope = new AsyncLocalStorage<WriteScope>();
  readonly #system;
  readonly #turns = new KeyedTurns<string>();
  readonly #creates = new KeyedTurns<string>();

  constructor(options: ProductFilesOptions) {
    this.#artifacts = options.artifacts;
    this.#execution = options.execution;
    this.#filesystem = artifactFileSystem({
      artifacts: options.artifacts,
      ...(options.onConflict ? { conflicted: options.onConflict } : {}),
      includes: isProductArtifact,
      mutation: (mutation) =>
        this.#stamp(mutation.operations, mutation.artifact),
      root: options.root,
      synchronize: (id, write) => this.#synchronize(id, write),
    });
    this.#system = new WorkspaceSystem().extend(
      directory({ filesystem: this.#filesystem, source: "artifact" })
    );
    this.#evidence = new FileEvidence({
      artifacts: options.artifacts,
      execution: options.execution,
      includes: isProductArtifact,
      product: (artifactId) => this.#product(artifactId),
    });
    this.#ready = this.#evidence.recoverAll();
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  async directory(artifactId: string): Promise<string> {
    return (await this.#workspace(artifactId)).root;
  }

  async read(
    artifactId: string,
    path: string,
    range: { readonly length: number; readonly offset: number }
  ): Promise<FileChunk | null> {
    const artifact = await this.#product(artifactId);
    const content = artifact?.content;
    const node = content?.tree[path];
    if (!(content && isUsableContent(content) && node?.type === "file")) {
      return null;
    }
    return await readRange(this.#artifacts, content.id, path, {
      end: range.offset + range.length,
      start: range.offset,
    });
  }

  async working(artifactId: string): Promise<string | null> {
    await this.#ready;
    return await this.#turns.run(artifactId, () => this.#working(artifactId));
  }

  async #working(
    artifactId: string,
    authorize?: FileAuthority
  ): Promise<string | null> {
    const artifact = await this.#product(artifactId);
    const from = artifact?.content;
    if (!(artifact && from?.state === "frozen")) {
      return from?.id ?? null;
    }
    const revised = await this.#execution.dispatch(
      WORKS_TASKS.fileRevise,
      { correlation: { artifactId } },
      async (context) => {
        let working: { readonly id: string } | null;
        try {
          working = await this.#artifacts.transaction(async (operations) => {
            const current = await operations.get(artifact.id);
            if (current?.content?.state !== "frozen") {
              return current?.content ?? null;
            }
            await authorize?.(operations, current);
            return operations.revise({
              artifactId: artifact.id,
              contentId: current.content.id,
              expectedUpdatedAt: current.content.updatedAt,
            });
          });
        } catch (error) {
          if (error instanceof FileWriteDenied) {
            observeAttempt(context, artifactId, "denied");
            return { denied: error };
          }
          throw error;
        }
        if (working && working.id !== from.id) {
          observeResult(context, OBSERVATION.revise, {
            artifactId,
            contentId: working.id,
            from: from.id,
          });
        }
        return { contentId: working?.id ?? null };
      }
    );
    if ("denied" in revised) {
      throw revised.denied;
    }
    return revised.contentId;
  }

  async create(input: FileCreateInput): Promise<FileCreateResult> {
    await this.#ready;
    const operation = scopedOperation(input.actor, input.request);
    const inputDigest = digestOf({
      bytes: createHash("sha256").update(input.bytes).digest("hex"),
      mime: input.mime,
      name: input.name,
      path: input.path,
    });
    return await this.#creates.run(operation, () =>
      this.#create(input, operation, inputDigest)
    );
  }

  async #create(
    input: FileCreateInput,
    operation: string,
    inputDigest: string
  ): Promise<FileCreateResult> {
    const prior = await this.#evidence.createdBy(operation);
    if (prior) {
      return prior.input === inputDigest
        ? createdResult(prior, input.path, true)
        : reused();
    }
    return await this.#execution.dispatch(
      WORKS_TASKS.fileCreate,
      {
        correlation: {
          operation,
          ...(input.actor.kind === "module"
            ? { moduleId: input.actor.moduleId }
            : {}),
        },
      },
      async (context) => {
        const origin = this.#origin(input.actor, context.run.id, {
          input: inputDigest,
          operation,
          path: input.path,
        });
        let created: ArtifactResolved;
        try {
          created = await this.#artifacts.transaction(async (operations) => {
            await input.authorize?.(operations, null);
            return operations.create({
              entries: {
                [input.path]: { bytes: input.bytes, mime: input.mime },
              },
              metadata: { entry: input.path, origin },
              name: input.name,
              type: input.mime,
            });
          });
        } catch (error) {
          if (error instanceof FileWriteDenied) {
            observeAttempt(context, null, "denied");
            return { kind: "denied", reason: error.message } as const;
          }
          throw error;
        }
        const { content } = created;
        if (!content) {
          throw new Error("The created file has no Content");
        }
        const evidence = evidenceOf(created.id, content, origin, input.path);
        if (!observeResult(context, OBSERVATION.create, evidence)) {
          this.#evidence.block(created.id);
        }
        return createdResult(evidence, input.path, false);
      }
    );
  }

  async save(input: FileSaveInput): Promise<FileSaveResult> {
    await this.#ready;
    const operation = scopedOperation(input.actor, input.request);
    const inputDigest = digestOf({
      artifactId: input.artifactId,
      expectedDigest: input.expectedDigest,
      path: input.path,
      text: input.text,
    });
    return await this.#turns.run(input.artifactId, async () => {
      if (!(await this.#evidence.reconcile(input.artifactId))) {
        return { kind: "refused", reason: EVIDENCE_REQUIRED } as const;
      }
      const prior = await this.#evidence.savedBy(
        input.artifactId,
        operation,
        input.retry === true &&
          this.#evidence.pruned(
            input.actor.kind === "module" ? input.actor.moduleId : undefined
          )
      );
      if (prior === "uncertain") {
        return {
          kind: "uncertain",
          reason:
            "Works cannot tell whether this save was made. Read the file again before saving.",
        } as const;
      }
      if (prior) {
        return prior.input === inputDigest
          ? savedResult(prior, true)
          : reused();
      }
      try {
        await this.#working(input.artifactId, input.authorize);
      } catch (error) {
        if (error instanceof FileWriteDenied) {
          return { kind: "denied", reason: error.message } as const;
        }
        throw error;
      }
      return this.#execution.dispatch(
        WORKS_TASKS.fileSave,
        {
          correlation: {
            artifactId: input.artifactId,
            operation,
            ...(input.actor.kind === "module"
              ? { moduleId: input.actor.moduleId }
              : {}),
          },
        },
        (context) =>
          this.#saveRun(
            context,
            input,
            this.#origin(input.actor, context.run.id, {
              input: inputDigest,
              operation,
              path: input.path,
            })
          )
      );
    });
  }

  async #saveRun(
    context: TaskContext,
    input: FileSaveInput,
    origin: FileOrigin
  ): Promise<FileSaveResult> {
    const scope: WriteScope = {
      ...(input.authorize ? { authorize: input.authorize } : {}),
      open: true,
      origin,
    };
    const outcome = await this.#within(scope, () => this.#write(input));
    if (scope.refusal) {
      observeAttempt(context, input.artifactId, "denied");
      return {
        kind: "denied",
        reason:
          scope.refusal instanceof Error
            ? scope.refusal.message
            : "This save is not allowed",
      };
    }
    if (outcome.kind !== "saved") {
      observeAttempt(context, input.artifactId, outcome.kind);
      return outcome;
    }
    if (!scope.written) {
      throw new Error("A saved file reported no Content");
    }
    const evidence = evidenceOf(
      input.artifactId,
      scope.written,
      origin,
      input.path
    );
    const recorded = observeResult(context, OBSERVATION.save, evidence);
    if (!recorded) {
      this.#evidence.block(input.artifactId);
    }
    return {
      ...savedResult(evidence, false),
      evidence: recorded ? "recorded" : "recovery-required",
    };
  }

  #within<T>(scope: WriteScope, write: () => Promise<T>): Promise<T> {
    return this.#scope.run(scope, async () => {
      try {
        return await write();
      } finally {
        scope.open = false;
      }
    });
  }

  async close(): Promise<void> {
    await this.#ready.catch(() => undefined);
    await this.#creates.idle();
    await this.#turns.idle();
    await this.#system.closeAll();
    await this.#filesystem.close();
  }

  async #write(input: FileSaveInput): Promise<
    | Exclude<FileSaveResult, { readonly kind: "saved" }>
    | {
        readonly kind: "saved";
        readonly snapshot: { readonly bytes: number; readonly digest: string };
      }
  > {
    const workspace = await this.#workspace(input.artifactId).catch(() => null);
    if (!workspace) {
      return { kind: "stale", reason: "This file is no longer available" };
    }
    const file = (await workspace.files()).find(
      (entry) => entry.path === input.path
    );
    if (!file) {
      return { kind: "stale", reason: `${input.path} is no longer present` };
    }
    const saved = await workspace.save({
      expectedDigest: input.expectedDigest,
      fileId: file.id,
      text: input.text,
    });
    return saved;
  }

  #workspace(artifactId: string) {
    return this.#system.load({ artifactId });
  }

  async #product(artifactId: string): Promise<ArtifactResolved | null> {
    const parsed = artifactIdSchema.safeParse(artifactId);
    const artifact = parsed.success
      ? await this.#artifacts.get(parsed.data)
      : null;
    return artifact && isProductArtifact(artifact) ? artifact : null;
  }

  #origin(
    actor: WriteActor,
    runId: string,
    operation: {
      readonly input: string;
      readonly operation: string;
      readonly path?: string | null;
    }
  ): FileOrigin {
    return {
      actor: actor.kind,
      at: new Date().toISOString(),
      ...operation,
      ...(actor.kind === "module"
        ? {
            installationId: actor.installationId,
            moduleId: actor.moduleId,
            runtimeInstanceId: actor.runtimeInstanceId,
          }
        : {}),
      runId,
    };
  }

  async #stamp(operations: ArtifactOperations, artifact: ArtifactResolved) {
    const scope = this.#scope.getStore();
    if (!scope?.open) {
      throw new Error("File Artifact writes go through Works");
    }
    try {
      await scope.authorize?.(operations, artifact);
    } catch (error) {
      scope.refusal = error;
      throw error;
    }
    return {
      committed: (content: ContentResolved) => {
        scope.written = content;
      },
      metadata: { origin: scope.origin },
    };
  }

  #synchronize(id: ArtifactId, write: () => Promise<void>): Promise<void> {
    return this.#turns.run(id, async () => {
      if (!(await this.#evidence.reconcile(id))) {
        throw new Error(EVIDENCE_REQUIRED);
      }
      await this.#execution.dispatch(
        WORKS_TASKS.fileSync,
        { correlation: { artifactId: id } },
        async (context) => {
          const scope: WriteScope = {
            open: true,
            origin: this.#origin({ kind: "disk" }, context.run.id, {
              input: "disk",
              operation: `disk:${context.run.id}`,
              path: null,
            }),
          };
          await this.#within(scope, write);
          const content = scope.written;
          if (content) {
            const evidence = evidenceOf(id, content, scope.origin, null);
            if (!observeResult(context, OBSERVATION.save, evidence)) {
              this.#evidence.block(id);
            }
          }
        }
      );
    });
  }
}

function observeAttempt(
  context: TaskContext,
  artifactId: string | null,
  outcome: SaveAttempt["outcome"]
): void {
  observeResult(context, OBSERVATION.attempt, {
    artifactId,
    kind: "file",
    outcome,
  });
}

function scopedOperation(actor: FileActor, request: string | undefined) {
  const id = request ?? randomUUID();
  return actor.kind === "module"
    ? `module:${actor.moduleId}:${id}`
    : `user:${id}`;
}

function digestOf(value: Readonly<Record<string, string>>): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(value).sort()))
    .digest("hex");
}

function savedResult(evidence: FileSaveEvidence, retried: boolean) {
  return {
    bytes: evidence.bytes,
    contentId: evidence.contentId,
    digest: evidence.digest,
    evidence: "recorded",
    kind: "saved",
    retried,
    updatedAt: evidence.updatedAt,
  } as const;
}

function createdResult(
  evidence: FileSaveEvidence,
  path: string,
  retried: boolean
) {
  return {
    artifactId: evidence.artifactId,
    bytes: evidence.bytes,
    contentId: evidence.contentId,
    digest: evidence.digest,
    kind: "created",
    path,
    retried,
    updatedAt: evidence.updatedAt,
  } as const;
}

function reused() {
  return {
    kind: "refused",
    reason: "That request id was already used for a different change",
  } as const;
}
