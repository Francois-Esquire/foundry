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
import { isModuleBuildOutputPath } from "./build";
import { MODULE_MIME } from "./constants";
import type { Module, ModuleId, ModuleVersion } from "./domain";
import { defineModule, defineModuleVersion } from "./domain";
import type { ModuleCapabilityCatalog } from "./gateway/types";
import {
  assertSemverTag,
  MODULE_MANIFEST_SOURCE_PATH,
  parseModuleManifestSourceText,
  validateModuleManifestBuild,
} from "./manifest";
import { unsupportedModuleRequirements } from "./preflight";
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

/** A build's result, published as a Version of the source it was built from. */
export interface ModuleBuildPublication {
  /** What the Manifest may select: the host's capabilities. */
  readonly catalog: Pick<ModuleCapabilityCatalog, "capabilities">;
  /** The saved source the build read; publication refuses once it moved. */
  readonly expected: ModuleSourceBinding;
  /** Merged into the Version's Content metadata in the same write (a host's attribution). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly moduleId: ModuleId;
  /** Build outputs by path, each under a package's `dist/`. */
  readonly outputs: Readonly<Record<string, Uint8Array>>;
  /** The source the Version embeds: the saved source and its resolved `bun.lock`. */
  readonly source: Readonly<Record<string, string>>;
  /** The Version's SemVer tag, unused by any earlier Version. */
  readonly tag: string;
}

export interface ModuleProjects {
  create(input: {
    readonly id: ModuleId;
    readonly name: string;
    readonly source: Readonly<Record<string, string>>;
  }): Promise<ModuleProject>;
  /**
   * Freezes a build's source and outputs as a new Version, in one write
   * fenced on the source the build read. The Manifest must select only
   * catalog capabilities and ask for nothing a host cannot run.
   */
  publish(input: ModuleBuildPublication): Promise<{
    /** The saved source now: the frozen Version's Content. */
    readonly binding: ModuleSourceBinding;
    readonly version: ModuleVersion;
  }>;
  saveWorkspaceSource(input: {
    readonly moduleId: ModuleId;
    readonly source: Readonly<Record<string, string>>;
    readonly expected: ModuleSourceBinding;
    /** Merged into the saved Content's metadata in the same write (a host's save attribution). */
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<ModuleSourceBinding>;
  workspaceSource(input: { readonly moduleId: ModuleId }): Promise<{
    readonly source: Readonly<Record<string, string>>;
    readonly binding: ModuleSourceBinding;
  }>;
}

/** Whether two bindings name the same saved revision of a Module's source. */
function sameModuleSourceBinding(
  left: ModuleSourceBinding,
  right: ModuleSourceBinding
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.contentId === right.contentId &&
    left.updatedAt.getTime() === right.updatedAt.getTime()
  );
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
    return { artifact, content: artifact.content, module };
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
    async publish(input: ModuleBuildPublication) {
      assertSemverTag(input.tag);
      const files: Record<string, FileInputs[string]> = {};
      for (const [path, bytes] of Object.entries(input.outputs)) {
        if (!isModuleBuildOutputPath(path)) {
          throw new ModuleProjectError(
            "Build output is outside a package dist directory"
          );
        }
        files[`outputs/${path}`] = { bytes };
      }
      for (const [path, text] of Object.entries(input.source)) {
        files[SOURCE_PREFIX + path] = { bytes: text };
      }
      const manifest = validateModuleManifestBuild({
        capabilities: input.catalog.capabilities,
        manifest: parseModuleManifestSourceText(
          input.source[MODULE_MANIFEST_SOURCE_PATH] ?? ""
        ),
        paths: Object.keys(files),
      });
      const unsupported = unsupportedModuleRequirements({ manifest });
      if (unsupported.length > 0) {
        throw new ModuleProjectError(
          `This release cannot run on this host: ${unsupported.map((fact) => fact.detail).join("; ")}`
        );
      }
      return artifacts.transaction(async (scoped) => {
        const { artifact, content, module } = await requireArtifact(
          input.moduleId,
          scoped
        );
        if (
          !sameModuleSourceBinding(bindingOf(artifact, content), input.expected)
        ) {
          throw new ModuleStoreConflictError(
            "Module source changed during the build; save and build again"
          );
        }
        const versions = await scoped.listContents(artifact.id, {
          state: "frozen",
          tagged: true,
        });
        if (versions.some((version) => version.tag === input.tag)) {
          throw new ModuleStoreConflictError(
            "This release version already exists; choose a new version"
          );
        }
        if (content.state === "frozen") {
          await scoped.revise({
            artifactId: artifact.id,
            contentId: content.id,
            expectedUpdatedAt: content.updatedAt,
          });
        }
        const current = await scoped.get(artifact.id);
        const landed = await scoped.write({
          artifactId: artifact.id,
          changes: { put: files, replace: true },
          expectedContentId: current?.contentId,
          freeze: { tag: input.tag },
          metadata: { ...input.metadata },
        });
        return {
          binding: bindingOf(landed.artifact, landed),
          version: defineModuleVersion({
            artifact: landed.artifact,
            content: landed,
            manifest,
            module,
          }),
        };
      });
    },
    async saveWorkspaceSource({
      moduleId,
      source,
      expected,
      metadata,
    }: Parameters<ModuleProjects["saveWorkspaceSource"]>[0]) {
      const entries = sourceFiles(source);
      return artifacts.transaction(async (scoped) => {
        const { artifact, content } = await requireArtifact(moduleId, scoped);
        if (!sameModuleSourceBinding(bindingOf(artifact, content), expected)) {
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
                metadata: { ...metadata, entry: undefined },
              })
            : await scoped.write({
                artifactId: artifact.id,
                changes,
                expectedContentId: content.id,
                expectedUpdatedAt: content.updatedAt,
                metadata: { ...metadata, entry: undefined },
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

function bindingOf(
  artifact: { readonly id: ArtifactId },
  content: { readonly id: ContentId; readonly updatedAt: Date }
): ModuleSourceBinding {
  return {
    artifactId: artifact.id,
    contentId: content.id,
    updatedAt: content.updatedAt,
  };
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
