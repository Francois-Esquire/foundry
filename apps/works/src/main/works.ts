import path from "node:path";
import type { ContainerRuntime } from "@foundry/sandbox/container/types";
import type { ModelManager, StateStore } from "@foundry.sh/marbles/engine";
import type { RouterContext } from "./api/context";
import { EditorBindings } from "./artifacts/bindings";
import { EditorPreferences } from "./artifacts/editor-preferences";
import { installedEditors } from "./artifacts/editors";
import {
  type ArtifactExplorer,
  createArtifactExplorer,
} from "./artifacts/explorer";
import { ProductFiles } from "./artifacts/files";
import type { ArtifactHost } from "./artifacts/gateway/host";
import { ExecutionAudit } from "./execution/audit";
import type { WorksExecution } from "./execution/contract";
import { startWorksEngine } from "./execution/engine";
import { routeModuleLibrary } from "./execution/library";
import { ModuleWorkflows } from "./execution/module-workflows";
import { ExecutionRetention } from "./execution/retention";
import {
  type SourceCommitter,
  SourceEvidence,
  type SourceSave,
  type SourceSaves,
} from "./execution/source-evidence";
import { WORKS_WORKFLOWS } from "./execution/workflows";
import type { WorksCapability } from "./gateway/provider-kit";
import { ModuleAccess, networkAccess } from "./modules/access";
import {
  type ModulePersistence,
  modulePersistence,
} from "./modules/artifact-store";
import {
  type AuthoringModels,
  ModuleAuthoring,
} from "./modules/authoring/service";
import { type BuildRuntime, ModuleBuilds } from "./modules/builds/controller";
import { createBuildRuntime } from "./modules/builds/runtime";
import {
  capabilityProviders,
  worksCapabilities,
  worksCapabilityCatalog,
} from "./modules/capabilities";
import { createModuleRecords, type ModuleLibrary } from "./modules/library";
import {
  openLocalModuleLibrary,
  openModuleStore,
} from "./modules/local-library";
import { ModulePower } from "./modules/power";
import {
  type ModuleRuntime,
  ModuleSessions,
} from "./modules/runtime/controller";
import { ProgramCalls } from "./modules/runtime/program-calls";
import {
  createModuleRuntime,
  type ModuleRuntimeOptions,
} from "./modules/runtime/runtime";
import { SandboxCapacity } from "./modules/sandboxes/capacity";
import { ModuleSandboxes } from "./modules/sandboxes/coordinator";
import { ModuleSettings } from "./modules/settings";
import { type QuitCleanup, shutdownInStages } from "./quit";
import type { SystemTheme } from "./system/theme";

export interface WorksOptions {
  readonly artifactRoot: string;
  readonly builds?: (sandboxes: ModuleSandboxes) => BuildRuntime;
  readonly containers?: () => Promise<ContainerRuntime>;
  readonly models: ModelManager;
  readonly moduleRoot: string;
  readonly print: (line: string) => void;
  readonly programs?: (options: ModuleRuntimeOptions) => Promise<ModuleRuntime>;
  readonly routes: AuthoringModels;
  readonly state?: (directory: string) => StateStore;
  readonly theme: SystemTheme;
  readonly userData: string;
}

interface WorksServices {
  readonly access: ModuleAccess;
  readonly artifacts: ArtifactExplorer;
  readonly audit: ExecutionAudit;
  readonly authoring: ModuleAuthoring;
  readonly builds: ModuleBuilds;
  readonly moduleSettings: ModuleSettings;
  readonly modules: ModuleLibrary;
  readonly power: ModulePower;
  readonly sessions: ModuleSessions;
  readonly theme: SystemTheme;
}

export interface Works {
  close(): Promise<void>;
  readonly rpc: WorksServices;
  readonly stages: readonly (readonly QuitCleanup[])[];
  readonly testing: {
    readonly bindings: EditorBindings;
    readonly calls: ProgramCalls;
    readonly execution: WorksExecution;
    readonly files: ProductFiles;
    readonly persistence: ModulePersistence;
    readonly runtime: ModuleRuntime;
    readonly workflows: ModuleWorkflows;
  };
}

export async function composeWorks(options: WorksOptions): Promise<Works> {
  const { print, userData } = options;
  const execution = await startWorksEngine({
    directory: path.join(userData, "engine"),
    models: options.models,
    print,
    ...(options.state
      ? { store: options.state(path.join(userData, "engine")) }
      : {}),
    workflows: WORKS_WORKFLOWS,
  });
  const opened: QuitCleanup[] = [{ shutdown: () => execution.close() }];
  try {
    return await composeOver(execution, options, (part) => {
      opened.unshift(part);
    });
  } catch (error) {
    for (const failure of await shutdownInStages(
      opened.map((part) => [part])
    )) {
      print(`Works startup cleanup failed: ${String(failure)}`);
    }
    throw error;
  }
}

async function composeOver(
  execution: WorksExecution,
  options: WorksOptions,
  opened: (part: QuitCleanup) => void
): Promise<Works> {
  const { moduleRoot, print, userData } = options;
  const store = await openModuleStore(moduleRoot, { legacyUserData: userData });
  const persistence = modulePersistence(store);
  const records = createModuleRecords(store);
  const moduleSettings = new ModuleSettings({
    directory: path.join(userData, "module-settings"),
    execution,
    library: records,
  });
  const applyQueues = (moduleId: string) =>
    moduleSettings.applyQueues(moduleId).catch((error: unknown) => {
      print(`Module ${moduleId} queues keep their defaults: ${String(error)}`);
    });
  const sourceEvidence = new SourceEvidence({
    execution,
    modules: persistence.modules,
  });
  for (const { error, moduleId } of await sourceEvidence.recoverAll()) {
    print(
      `Module ${moduleId} source save evidence not recovered: ${String(error)}`
    );
  }
  const library = await openLocalModuleLibrary(moduleRoot, {
    records,
    saves: followSaves(sourceEvidence, applyQueues),
  });
  const modules = routeModuleLibrary(library, execution, {
    added: applyQueues,
  });

  const files = new ProductFiles({
    artifacts: persistence.artifacts,
    execution,
    onConflict: ({ artifactId, directory }) => {
      print(
        `Disk edits to Artifact ${artifactId} conflicted with a save and were kept in ${directory}`
      );
    },
    root: options.artifactRoot,
  });
  opened({ shutdown: () => files.close() });
  const bindings = new EditorBindings();
  const workflows = new ModuleWorkflows({ execution, models: options.routes });
  const capacity = new SandboxCapacity();
  const power = new ModulePower({
    execution,
    file: path.join(userData, "module-power.json"),
  });
  const admit = (moduleId: string) => power.admit(moduleId);
  const sandboxes = new ModuleSandboxes({
    admit,
    capacity,
    instance: moduleRoot,
    resources: (moduleId) => moduleSettings.sandboxResources(moduleId),
    runtime:
      options.containers ??
      (async () => {
        const { createMicrosandboxRuntime } = await import(
          "@foundry/sandbox/container/microsandbox-runtime"
        );
        return createMicrosandboxRuntime();
      }),
  });
  opened(sandboxes);
  const artifactHost: ArtifactHost = {
    artifacts: persistence.artifacts,
    bindings,
    files,
    limits: (moduleId) => moduleSettings.artifactLimits(moduleId),
    modules: persistence.modules,
  };
  const gateway = worksCapabilities({
    artifacts: artifactHost,
    execution: { modules: persistence.modules, workflows },
    theme: options.theme,
  });
  const providers = capabilityProviders(gateway);
  const builds = new ModuleBuilds({
    execution,
    library: modules,
    runtime:
      options.builds?.(sandboxes) ??
      createBuildRuntime(sandboxes, worksCapabilityCatalog(providers)),
  });
  const calls = new ProgramCalls();
  const runtime = await (options.programs ?? createModuleRuntime)({
    capacity,
    execution,
    observeInvocation: calls.record,
    persistence,
    providers,
    root: moduleRoot,
    settings: moduleSettings,
    stopped: async (installationId) => {
      bindings.stopped(installationId);
      await workflows.cancelInstallation(installationId);
    },
  });
  const sessions = new ModuleSessions({
    admit,
    calls,
    execution,
    library: modules,
    runtime,
  });
  opened(sessions);
  power.govern(sessions);
  power.govern({
    live: (moduleId) => sandboxes.live().includes(moduleId),
    stop: (moduleId) => sandboxes.stop(moduleId),
  });
  const capabilities: readonly WorksCapability[] = [
    ...gateway,
    networkAccess((moduleId) => sessions.restart(moduleId)),
  ];
  const access = new ModuleAccess({
    capabilities,
    execution,
    library: modules,
    runtime,
    store: persistence.modules,
  });
  const authoring = new ModuleAuthoring({
    directory: path.join(userData, "authoring"),
    execution,
    library: modules,
    limits: (moduleId) => moduleSettings.authoringLimits(moduleId),
    models: options.routes,
    sandboxes,
  });
  const retention = new ExecutionRetention({
    policy: (moduleId) => moduleSettings.auditRetention(moduleId),
    runs: execution.runs,
  });
  const explorer = createArtifactExplorer(persistence.artifacts, {
    bindings,
    editors: installedEditors({ library: modules, store: persistence.modules }),
    files,
    preferences: new EditorPreferences({
      file: path.join(userData, "editor-preferences.json"),
    }),
  });

  for (const module of await modules.list()) {
    await applyQueues(module.id);
  }
  await files.ready();
  opened(retention);
  try {
    await retention.start();
  } catch (error) {
    print(`Run retention failed: ${String(error)}`);
  }

  const stages: Works["stages"] = [
    [authoring, builds, sessions, workflows, retention],
    [sandboxes, { shutdown: () => files.close() }],
    [{ shutdown: () => execution.close() }],
  ];
  const rpc = {
    access,
    artifacts: explorer,
    audit: new ExecutionAudit({ retention, runs: execution.runs }),
    authoring,
    builds,
    moduleSettings,
    modules,
    power,
    sessions,
    theme: options.theme,
  } satisfies Omit<RouterContext, "vault">;
  return {
    async close(): Promise<void> {
      const failures = await shutdownInStages(stages);
      if (failures.length) {
        throw new AggregateError(failures, "Works cleanup failed");
      }
    },
    rpc,
    stages,
    testing: {
      bindings,
      calls,
      execution,
      files,
      persistence,
      runtime,
      workflows,
    },
  };
}

function followSaves(
  saves: SourceSaves,
  changed: (moduleId: string) => Promise<void>
): SourceSaves {
  return {
    admit: (moduleId) => saves.admit(moduleId),
    async run<T>(save: SourceSave, commit: SourceCommitter<T>): Promise<T> {
      let committed = false;
      try {
        const value = await saves.run<T>(save, (origin, record) =>
          commit(origin, (saved) => {
            committed = true;
            record(saved);
          })
        );
        committed = true;
        return value;
      } finally {
        if (committed) {
          await changed(save.moduleId);
        }
      }
    },
  };
}
