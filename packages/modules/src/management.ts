import type { Artifacts, ContentId } from "@foundry/artifacts";
import type { Page, PageInput } from "@foundry/core/pagination";

import type {
  Installation,
  InstallationId,
  Module,
  ModuleId,
  ModuleVersion,
} from "./domain";
import { installationIdSchema } from "./domain";
import { importModulePackage } from "./package";
import type { ModuleProgramSupervisor } from "./platform/contracts";
import type { ModuleProjects } from "./projects";
import { createModuleProjects } from "./projects";
import type { ModuleGatewayContext, ModuleStore } from "./store/contract";
import {
  ModuleStoreConflictError,
  ModuleStoreNotFoundError,
} from "./store/contract";
import { createModuleVersions } from "./version";

export interface ModuleView {
  readonly id: string;
  readonly path: string;
  readonly title?: string;
}

export interface ModuleManagement extends ModuleProjects {
  createInstallation(input: {
    readonly moduleId: ModuleId;
    readonly contentId: ContentId;
  }): Promise<Installation>;
  delete(input: {
    readonly installationId: InstallationId;
    readonly expectedGeneration: number;
  }): Promise<void>;
  deleteModule(input: { readonly moduleId: ModuleId }): Promise<void>;
  getInstallation(input: {
    readonly installationId: InstallationId;
  }): Promise<ModuleGatewayContext | null>;
  importPackage(input: { readonly encoded: string }): Promise<ModuleVersion>;
  listInstallations(input?: PageInput): Promise<Page<Installation>>;
  listModules(input?: PageInput): Promise<Page<Module>>;
  listVersions(input: {
    readonly moduleId: ModuleId;
    readonly page?: PageInput;
  }): Promise<Page<ModuleVersion>>;
  /** Requires a stopped Installation; activation and approval are separate. */
  selectVersion(input: {
    readonly installationId: InstallationId;
    readonly contentId: ContentId;
    readonly expectedGeneration: number;
  }): Promise<Installation>;
  views(input: {
    readonly installationId: InstallationId;
  }): Promise<readonly ModuleView[]>;
}

export function createModuleManagement(options: {
  readonly artifacts: Artifacts;
  readonly store: ModuleStore;
  readonly programs: Pick<ModuleProgramSupervisor, "selectVersion" | "delete">;
  readonly now?: () => Date;
  readonly createInstallationId?: () => InstallationId;
}): ModuleManagement {
  const { artifacts, store, programs } = options;
  const versions = createModuleVersions({ artifacts, store });
  const projects = createModuleProjects({ artifacts, store });
  const now = options.now ?? (() => new Date());
  const createInstallationId =
    options.createInstallationId ??
    (() => installationIdSchema.parse(crypto.randomUUID()));

  async function requireVersion(moduleId: ModuleId, contentId: ContentId) {
    const version = await versions.load({ contentId, moduleId });
    if (version === null) {
      throw new ModuleStoreConflictError(
        `Content ${contentId} is not a version of Module ${moduleId}`
      );
    }
    return version;
  }

  return Object.freeze({
    ...projects,
    async createInstallation({
      moduleId,
      contentId,
    }: Parameters<ModuleManagement["createInstallation"]>[0]) {
      const version = await requireVersion(moduleId, contentId);
      return store.createInstallation({
        id: createInstallationId(),
        now: now(),
        version,
      });
    },
    delete: (input: Parameters<ModuleManagement["delete"]>[0]) =>
      programs.delete(input),
    async deleteModule({ moduleId }: { readonly moduleId: ModuleId }) {
      const module = await store.loadModule(moduleId);
      if (module === null) {
        throw new ModuleStoreConflictError(
          `Module ${moduleId} is not registered`
        );
      }
      const installations: Installation[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listInstallations({
          moduleId,
          ...(cursor === undefined ? {} : { cursor }),
        });
        installations.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      for (const installation of installations) {
        await programs.delete({
          expectedGeneration: installation.generation,
          installationId: installation.id,
        });
      }
      await artifacts.transaction((scoped) =>
        store.transaction(async () => {
          await store.deleteModule({ moduleId });
          await scoped.archive(module.artifactId);
        })
      );
    },
    getInstallation: ({
      installationId,
    }: {
      readonly installationId: InstallationId;
    }) => store.loadGatewayContext(installationId),
    importPackage: ({ encoded }: { readonly encoded: string }) =>
      importModulePackage({ artifacts, encoded, modules: store }),
    listInstallations: (input?: PageInput) => store.listInstallations(input),
    listModules: (input?: PageInput) => store.listModules(input),
    listVersions: (input: Parameters<ModuleManagement["listVersions"]>[0]) =>
      versions.list(input),
    selectVersion: (input: Parameters<ModuleManagement["selectVersion"]>[0]) =>
      programs.selectVersion(input),
    async views({
      installationId,
    }: {
      readonly installationId: InstallationId;
    }) {
      const context = await store.loadGatewayContext(installationId);
      if (context === null) {
        throw new ModuleStoreNotFoundError(installationId);
      }
      const version = await requireVersion(
        context.installation.moduleId,
        context.installation.contentId
      );
      return Object.freeze(
        Object.entries(version.manifest.views)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, view]) => Object.freeze({ id, ...view }))
      );
    },
  });
}
