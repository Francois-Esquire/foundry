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
import { SourceEvidence, type SourceSaves } from "./execution/source-evidence";
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
  /** Product File Artifacts, one directory each (`~/.foundry/artifacts`). */
  readonly artifactRoot: string;
  // ── Stand-ins, for tests and smokes; the real ones otherwise ──
  /** How a Module's builds run in its sandbox. */
  readonly builds?: (sandboxes: ModuleSandboxes) => BuildRuntime;
  /** The VM runtime of Module sandboxes; Microsandbox, loaded at first use. */
  readonly containers?: () => Promise<ContainerRuntime>;
  /** The providers engine agent sessions route to. */
  readonly models: ModelManager;
  /** Module folders: source, selected release and private data (`~/.foundry/modules`). */
  readonly moduleRoot: string;
  readonly print: (line: string) => void;
  /** Released Programs; Microsandbox VMs under `moduleRoot`. */
  readonly programs?: (options: ModuleRuntimeOptions) => Promise<ModuleRuntime>;
  /** Model routes for chat turns and Module workflows. */
  readonly routes: AuthoringModels;
  /** The engine's state store, in place of the one under `userData/engine`. */
  readonly state?: (directory: string) => StateStore;
  /** Main's theme, opened by the caller before any window or Program. */
  readonly theme: SystemTheme;
  /** Works' own state: engine, settings, chat, editor choices and Module on/off. */
  readonly userData: string;
}

/** What main serves the renderer's RPC router, besides the vault. */
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

/** Works main, composed. */
export interface Works {
  /** Runs the quit stages; tests and smokes close Works with it. */
  close(): Promise<void>;
  readonly rpc: WorksServices;
  /** Quit cleanup: work drains before the sandboxes and engine it uses close. */
  readonly stages: readonly (readonly QuitCleanup[])[];
  /** Parts tests and smokes reach into; the Electron entry never does. */
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

/**
 * Works main, composed: the engine, the Module library with its save
 * evidence, product files, Module settings, sandboxes, builds, released
 * Programs, Access with every capability's Grant hooks, chat, workflows,
 * retention and audit. Resolves once startup recovery is done and Works may
 * accept a save or a launch; a failure on the way closes what had opened.
 * The Electron entry adds windows, the `module-app:` protocol, the vault and
 * quit; smokes and tests compose the same Works with stand-ins for what they
 * cannot run.
 */
export async function composeWorks(options: WorksOptions): Promise<Works> {
  const { print, userData } = options;
  // The required engine starts, recovering its queues and run store, before
  // Works accepts a save or a launch.
  const execution = await startWorksEngine({
    directory: path.join(userData, "engine"),
    models: options.models,
    print,
    ...(options.state
      ? { store: options.state(path.join(userData, "engine")) }
      : {}),
    workflows: WORKS_WORKFLOWS,
  });
  // What has opened, newest first: closed in that order if a later step fails.
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

/** Everything after the engine; `opened` learns each part that needs closing. */
async function composeOver(
  execution: WorksExecution,
  options: WorksOptions,
  opened: (part: QuitCleanup) => void
): Promise<Works> {
  const { moduleRoot, print, userData } = options;
  // The Module records store and its one shared manager: the library,
  // Module settings, Access, released Programs and product files all read
  // and write through it, in one transaction order.
  const store = await openModuleStore(moduleRoot, { legacyUserData: userData });
  const persistence = modulePersistence(store);
  const records = createModuleRecords(store);
  const moduleSettings = new ModuleSettings({
    directory: path.join(userData, "module-settings"),
    execution,
    library: records,
  });
  // Settings reads never touch queues: a Module's queues take its settings
  // at startup, on a settings change and whenever its Manifest may have
  // changed, which is also when its kept effective settings are read again.
  // A problem keeps the engine's defaults; it never fails a save.
  const applyQueues = (moduleId: string) =>
    moduleSettings.applyQueues(moduleId).catch((error: unknown) => {
      print(`Module ${moduleId} queues keep their defaults: ${String(error)}`);
    });
  // Source and release saves stamp their origin; one whose result could not
  // be recorded blocks the Module's next save until it is recovered, which
  // startup does first, before anything saves.
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

  // Product File Artifacts: one directory each, edited through Workspaces
  // on the same manager as Module records, so a save and a Grant revocation
  // share one transaction order.
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
  // Module off stops its apps, then its sandbox; while off, neither starts.
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
  // Each Program's Gateway invocations are recorded on its lifetime run.
  const calls = new ProgramCalls();
  const runtime = await (options.programs ?? createModuleRuntime)({
    capacity,
    execution,
    observeInvocation: calls.record,
    persistence,
    providers,
    root: moduleRoot,
    settings: moduleSettings,
    // A stopped Program's workflows end with it.
    stopped: (installationId) => workflows.cancelInstallation(installationId),
  });
  const sessions = new ModuleSessions({
    admit,
    calls,
    execution,
    library: modules,
    runtime,
  });
  // Shutting the sessions down shuts the Program runtime down after them.
  opened(sessions);
  power.govern(sessions);
  power.govern({
    live: (moduleId) => sandboxes.live().includes(moduleId),
    stop: (moduleId) => sandboxes.stop(moduleId),
  });
  // Access: every Gateway capability, and `network`, whose change restarts
  // the Module's running apps.
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
  // Run-store retention: each Module's audit settings, host defaults
  // otherwise. File saves recover their missing results first, so a save
  // checkpoint is in place before anything is pruned.
  await files.ready();
  opened(retention);
  try {
    await retention.start();
  } catch (error) {
    // History stays whole; the next interval tries again.
    print(`Run retention failed: ${String(error)}`);
  }

  const stages: Works["stages"] = [
    [authoring, builds, sessions, workflows, retention],
    // Disk synchronization dispatches on the engine: close it first.
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

/**
 * `saves`, telling `changed` once a save committed: the Module's Manifest
 * may have changed with it.
 */
function followSaves(
  saves: SourceSaves,
  changed: (moduleId: string) => Promise<void>
): SourceSaves {
  return {
    admit: (moduleId) => saves.admit(moduleId),
    async run(save, commit) {
      const value = await saves.run(save, commit);
      await changed(save.moduleId);
      return value;
    },
  };
}
