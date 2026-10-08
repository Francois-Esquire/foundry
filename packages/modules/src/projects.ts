import type {
  ArtifactId,
  ArtifactOperations,
  Artifacts,
  ContentId,
  FileInputs,
} from "@foundry/artifacts";

import { isUsableContent } from "@foundry/artifacts";
import { isStoragePath } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { decodeUtf8 } from "@foundry/lib/encoding";
import { MODULE_MIME } from "./constants";
import type { Module, ModuleId } from "./domain";
import { defineModule } from "./domain";
import {
  MODULE_MANIFEST_SOURCE_PATH,
  parseModuleManifestSourceText,
} from "./manifest";
import type { ModuleStore } from "./store/contract";
import { ModuleStoreConflictError } from "./store/contract";

const SOURCE_PREFIX = "source/";

export interface ModuleSourceBinding {
  readonly artifactId: ArtifactId;
  readonly contentId: ContentId;
  readonly updatedAt: Date;
}

export interface ModuleProject {
  readonly artifactId: ArtifactId;
  readonly idempotent: boolean;
  readonly module: Module;
}

export interface ModuleProjects {
  create(input: {
    readonly id: ModuleId;
    readonly name: string;
    readonly source: Readonly<Record<string, string>>;
  }): Promise<ModuleProject>;
  saveWorkspaceSource(input: {
    readonly moduleId: ModuleId;
    readonly source: Readonly<Record<string, string>>;
    readonly expected: ModuleSourceBinding;
  }): Promise<ModuleSourceBinding>;
  workspaceSource(input: { readonly moduleId: ModuleId }): Promise<{
    readonly source: Readonly<Record<string, string>>;
    readonly binding: ModuleSourceBinding;
  }>;
}

export class ModuleProjectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleProjectError";
  }
}

export function createModuleProjects(options: {
  readonly artifacts: Artifacts;
  readonly store: Pick<
    ModuleStore,
    "loadModule" | "registerModule" | "transaction"
  >;
}): ModuleProjects {
  const { artifacts, store } = options;

  /** Pass the transaction handle when called inside `artifacts.transaction`. */
  async function requireArtifact(
    moduleId: ModuleId,
    reader: Pick<ArtifactOperations, "get"> = artifacts
  ) {
    const module = await store.loadModule(moduleId);
    if (module === null) {
      throw new ModuleProjectError(`Module ${moduleId} is not registered`);
    }
    const artifact = await reader.get(module.artifactId);
    if (artifact?.type !== MODULE_MIME || !isUsableContent(artifact.content)) {
      throw new ModuleProjectError(
        `Module ${moduleId} has no authored Content`
      );
    }
    return { artifact, content: artifact.content };
  }

  return Object.freeze({
    async create(input: Parameters<ModuleProjects["create"]>[0]) {
      const entries = sourceFiles(input.source);
      validateManifest(input.source);
      return artifacts.transaction((scoped) =>
        store.transaction(async () => {
          const existing = await store.loadModule(input.id);
          if (existing !== null) {
            return {
              artifactId: existing.artifactId,
              idempotent: true,
              module: existing,
            };
          }
          const artifact = await scoped.create({
            entries,
            name: input.name,
            type: MODULE_MIME,
          });
          const module = await store.registerModule({
            module: defineModule({ artifact, id: input.id }),
          });
          return { artifactId: artifact.id, idempotent: false, module };
        })
      );
    },
    async saveWorkspaceSource({
      moduleId,
      source,
      expected,
    }: Parameters<ModuleProjects["saveWorkspaceSource"]>[0]) {
      const entries = sourceFiles(source);
      return artifacts.transaction(async (scoped) => {
        const { artifact, content } = await requireArtifact(moduleId, scoped);
        if (
          artifact.id !== expected.artifactId ||
          content.id !== expected.contentId ||
          content.updatedAt.getTime() !== expected.updatedAt.getTime()
        ) {
          throw new ModuleStoreConflictError(
            "Module source changed since this workspace opened; reopen before saving"
          );
        }
        const changes = { put: entries, replace: true } as const;
        const saved =
          content.state === "frozen"
            ? await scoped.revise({
                artifactId: artifact.id,
                changes,
                contentId: content.id,
                expectedUpdatedAt: content.updatedAt,
                metadata: { entry: undefined },
              })
            : await scoped.write({
                artifactId: artifact.id,
                changes,
                expectedContentId: content.id,
                expectedUpdatedAt: content.updatedAt,
                metadata: { entry: undefined },
              });
        return {
          artifactId: artifact.id,
          contentId: saved.id,
          updatedAt: saved.updatedAt,
        };
      });
    },
    async workspaceSource({
      moduleId,
    }: Parameters<ModuleProjects["workspaceSource"]>[0]) {
      const { artifact, content } = await requireArtifact(moduleId);
      const source = new Map<string, string>();
      for (const [path, entry] of Object.entries(content.tree)) {
        if (!path.startsWith(SOURCE_PREFIX)) {
          continue;
        }
        if (entry.type === "directory") {
          continue;
        }
        if (entry.type !== "file") {
          throw new ModuleProjectError(
            `Module source ${path} is not a regular file`
          );
        }
        const file = await artifacts.readFile(content.id, path);
        if (file === null || (await sha256Hex(file.blob)) !== entry.digest) {
          throw new ModuleProjectError(
            `Module source ${path} failed byte verification`
          );
        }
        const text = decodeUtf8(file.blob);
        if (text === null) {
          throw new ModuleProjectError(`Module source ${path} is not UTF-8`);
        }
        source.set(path.slice(SOURCE_PREFIX.length), text);
      }
      const captured = Object.freeze(Object.fromEntries(source));
      sourceFiles(captured);
      return {
        binding: {
          artifactId: artifact.id,
          contentId: content.id,
          updatedAt: content.updatedAt,
        },
        source: captured,
      };
    },
  });
}

function sourceFiles(source: Readonly<Record<string, string>>): FileInputs {
  const paths = Object.keys(source).sort();
  if (paths.length === 0) {
    throw new ModuleProjectError("Module workspace has no source");
  }
  for (const path of paths) {
    if (!isStoragePath(path)) {
      throw new ModuleProjectError(
        `Invalid Module source path ${JSON.stringify(path)}`
      );
    }
    if (paths.some((other) => other.startsWith(`${path}/`))) {
      throw new ModuleProjectError("Module source contains conflicting paths");
    }
  }
  const files: Record<string, FileInputs[string]> = {
    profile: {
      bytes: JSON.stringify({ harness: "module" }),
      mime: "application/json",
    },
  };
  for (const [path, bytes] of Object.entries(source)) {
    files[SOURCE_PREFIX + path] = { bytes };
  }
  return files;
}

function validateManifest(source: Readonly<Record<string, string>>): void {
  const manifest = source[MODULE_MANIFEST_SOURCE_PATH];
  if (
    !Object.hasOwn(source, MODULE_MANIFEST_SOURCE_PATH) ||
    manifest === undefined
  ) {
    throw new ModuleProjectError("Module source has no manifest");
  }
  try {
    parseModuleManifestSourceText(manifest);
  } catch (cause) {
    throw new ModuleProjectError("Module source manifest is invalid", {
      cause,
    });
  }
}
