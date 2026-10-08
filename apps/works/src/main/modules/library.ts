import { join } from "node:path";
import {
  type ArtifactStore,
  artifactIdSchema,
  contentIdSchema,
  type FileInputs,
} from "@foundry/artifacts";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import {
  defineModuleVersion,
  type ModuleVersion,
  moduleIdSchema,
} from "@foundry/modules/domain";
import {
  assertSemverTag,
  isPortableRelativePath,
  parseModuleManifestSourceText,
  validateModuleManifestBuild,
} from "@foundry/modules/manifest";
import { importModulePackage } from "@foundry/modules/package";
import { createModuleProjects } from "@foundry/modules/projects";
import { ModuleStoreConflictError } from "@foundry/modules/store/contract";
import { createModuleVersions } from "@foundry/modules/version";
import type {
  ModuleDetails,
  ModuleSourceRevision,
  ModuleSummary,
} from "~/shared/modules";
import { createModulePersistence } from "./artifact-store";
import { moduleStarter } from "./starter";

const OUTPUT_PATH = /^packages\/[^/]+\/dist\/.+/u;

export interface ModuleLibrary {
  create(name: string): Promise<ModuleSummary>;
  details(id: string): Promise<ModuleDetails | null>;
  importPackage(encoded: string): Promise<ModuleSummary>;
  list(): Promise<ModuleSummary[]>;
  publish(
    id: string,
    expected: ModuleSourceRevision,
    input: {
      source: Record<string, string>;
      outputs: Record<string, Uint8Array>;
      tag: string;
    }
  ): Promise<{ version: ModuleVersion; binding: ModuleSourceRevision }>;
  release(id: string, contentId: string): Promise<ModuleVersion | null>;
  saveSource(
    id: string,
    source: Record<string, string>,
    expected: ModuleSourceRevision
  ): Promise<ModuleSourceRevision>;
}

export function openModuleLibrary(userData: string): ModuleLibrary {
  return createModuleLibrary(
    new JsonArtifactStore({ path: join(userData, "modules", "artifacts.json") })
  );
}

export function createModuleLibrary(store: ArtifactStore): ModuleLibrary {
  const { artifacts, modules, registered } = createModulePersistence(store);
  const projects = createModuleProjects({ artifacts, store: modules });
  const versions = createModuleVersions({ artifacts, store: modules });
  function summary(
    artifact: Awaited<ReturnType<typeof registered>>[number]
  ): ModuleSummary {
    return {
      artifactId: artifact.id,
      id: moduleIdSchema.parse(artifact.metadata.moduleId),
      name: artifact.name,
      updatedAt: artifact.updatedAt.toISOString(),
    };
  }
  async function requireSummary(id: string): Promise<ModuleSummary> {
    const found = (await registered()).find(
      (record) => record.metadata.moduleId === id
    );
    if (!found) {
      throw new Error("Module registration was not saved");
    }
    return summary(found);
  }
  async function releases(id: string) {
    const module = await modules.loadModule(moduleIdSchema.parse(id));
    if (!module) {
      return [];
    }
    const contents = await artifacts.listContents(module.artifactId, {
      state: "frozen",
      tagged: true,
    });
    const sorted = contents.toSorted(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
    const released = await Promise.all(
      sorted.map((content) =>
        versions.load({ contentId: content.id, moduleId: module.id })
      )
    );
    return released.flatMap((version) =>
      version
        ? [
            {
              contentId: version.contentId,
              tag: version.tag,
              views: Object.entries(version.manifest.views).map(
                ([viewId, view]) => ({ id: viewId, ...view })
              ),
            },
          ]
        : []
    );
  }
  return {
    async create(name) {
      const id = moduleIdSchema.parse(crypto.randomUUID());
      await projects.create({
        id,
        name,
        source: await moduleStarter(id, name),
      });
      return requireSummary(id);
    },
    async details(id) {
      const module = await modules.loadModule(moduleIdSchema.parse(id));
      if (!module) {
        return null;
      }
      const record = await requireSummary(id);
      const artifact = await artifacts.get(module.artifactId);
      const tree =
        artifact?.content && "tree" in artifact.content
          ? artifact.content.tree
          : {};
      if (!Object.keys(tree).some((path) => path.startsWith("source/"))) {
        return {
          ...record,
          binding: null,
          releases: await releases(id),
          source: {},
        };
      }
      const workspace = await projects.workspaceSource({ moduleId: module.id });
      return {
        ...record,
        binding: serializeBinding(workspace.binding),
        releases: await releases(id),
        source: { ...workspace.source },
      };
    },
    async importPackage(encoded) {
      const version = await importModulePackage({
        artifacts,
        encoded,
        modules,
      });
      return requireSummary(version.moduleId);
    },
    async list() {
      return (await registered()).map(summary);
    },
    async publish(id, expected, input) {
      assertSemverTag(input.tag);
      const moduleId = moduleIdSchema.parse(id);
      const files: Record<string, FileInputs[string]> = {};
      for (const [path, bytes] of Object.entries(input.outputs)) {
        if (!(isPortableRelativePath(path) && OUTPUT_PATH.test(path))) {
          throw new Error("Build output is outside a package dist directory");
        }
        files[`outputs/${path}`] = { bytes };
      }
      for (const [path, text] of Object.entries(input.source)) {
        files[`source/${path}`] = { bytes: text };
      }
      const manifest = validateModuleManifestBuild({
        capabilities: [],
        manifest: parseModuleManifestSourceText(
          input.source["foundry.module.json"] ?? ""
        ),
        paths: Object.keys(files),
      });
      return artifacts.transaction(async (scoped) => {
        const module = await modules.loadModule(moduleId);
        if (!module) {
          throw new Error("Module not found");
        }
        const artifact = await scoped.get(module.artifactId);
        const content = artifact?.content;
        if (
          !content ||
          module.artifactId !== expected.artifactId ||
          content.id !== expected.contentId ||
          content.updatedAt.getTime() !== Date.parse(expected.updatedAt)
        ) {
          throw new ModuleStoreConflictError(
            "Module source changed during the build; save and build again"
          );
        }
        const existing = await scoped.listContents(module.artifactId, {
          state: "frozen",
          tagged: true,
        });
        if (existing.some((version) => version.tag === input.tag)) {
          throw new ModuleStoreConflictError(
            "This release version already exists; choose a new version"
          );
        }
        if (content.state === "frozen") {
          await scoped.revise({
            artifactId: module.artifactId,
            contentId: content.id,
            expectedUpdatedAt: content.updatedAt,
          });
        }
        const current = await scoped.get(module.artifactId);
        const landed = await scoped.write({
          artifactId: module.artifactId,
          changes: { put: files, replace: true },
          expectedContentId: current?.contentId,
          freeze: { tag: input.tag },
        });
        return {
          binding: serializeBinding({
            artifactId: module.artifactId,
            contentId: landed.id,
            updatedAt: landed.updatedAt,
          }),
          version: defineModuleVersion({
            artifact: landed.artifact,
            content: landed,
            manifest,
            module,
          }),
        };
      });
    },
    release(id, contentId) {
      return versions.load({
        contentId: contentIdSchema.parse(contentId),
        moduleId: moduleIdSchema.parse(id),
      });
    },
    async saveSource(id, source, expected) {
      parseModuleManifestSourceText(source["foundry.module.json"] ?? "");
      const binding = await projects.saveWorkspaceSource({
        expected: parseBinding(expected),
        moduleId: moduleIdSchema.parse(id),
        source,
      });
      return serializeBinding(binding);
    },
  };
}

function parseBinding(binding: ModuleSourceRevision) {
  return {
    artifactId: artifactIdSchema.parse(binding.artifactId),
    contentId: contentIdSchema.parse(binding.contentId),
    updatedAt: new Date(binding.updatedAt),
  };
}

function serializeBinding(binding: {
  artifactId: string;
  contentId: string;
  updatedAt: Date;
}): ModuleSourceRevision {
  return { ...binding, updatedAt: binding.updatedAt.toISOString() };
}
