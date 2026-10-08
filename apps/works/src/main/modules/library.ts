import { join } from "node:path";
import type { ArtifactStore } from "@foundry/artifacts";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import { moduleIdSchema } from "@foundry/modules/domain";
import { importModulePackage } from "@foundry/modules/package";
import { createModuleProjects } from "@foundry/modules/projects";
import type { ModuleDetails, ModuleSummary } from "~/shared/modules";
import { createModulePersistence } from "./artifact-store";
export interface ModuleLibrary {
  create(name: string): Promise<ModuleSummary>;
  details(id: string): Promise<ModuleDetails | null>;
  importPackage(encoded: string): Promise<ModuleSummary>;
  list(): Promise<ModuleSummary[]>;
}

export function openModuleLibrary(userData: string): ModuleLibrary {
  return createModuleLibrary(
    new JsonArtifactStore({ path: join(userData, "modules", "artifacts.json") })
  );
}

export function createModuleLibrary(store: ArtifactStore): ModuleLibrary {
  const { artifacts, modules, registered } = createModulePersistence(store);
  const projects = createModuleProjects({ artifacts, store: modules });
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
  return {
    async create(name) {
      const id = moduleIdSchema.parse(crypto.randomUUID());
      await projects.create({
        id,
        name,
        source: {
          "foundry.module.json": JSON.stringify(
            {
              capabilities: [],
              compatibility: { gateway: "1", runtime: "bun@1" },
              format: "foundry.module/1",
              program: { entry: "outputs/program.js" },
              views: {},
            },
            null,
            2
          ),
          "README.md": `# ${name}\n\nThis Module has authored source. Add a program and build outputs before publishing or running it.\n`,
        },
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
        return { ...record, source: {} };
      }
      const workspace = await projects.workspaceSource({ moduleId: module.id });
      return { ...record, source: { ...workspace.source } };
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
  };
}
