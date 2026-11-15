import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { InMemorySessionStore } from "@foundry/agents/store/memory";
import type { Artifacts } from "@foundry/artifacts";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { InMemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { showArgv } from "@foundry/lib/argv";
import type { Provider } from "@foundry/models";
import { ModelManager } from "@foundry/models";
import type { Containers } from "@foundry/sandbox/container/containers";
import { createContainers } from "@foundry/sandbox/container/containers";
import type { ContainerStore } from "@foundry/sandbox/store";
import { createMemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import type { GitRun } from "@foundry/workspaces/git";
import { Catalog } from "~/authoring/catalog";
import { DatabaseActivityStore } from "~/database/activities";
import { DatabaseDeferredApprovalStore } from "~/database/approvals";
import {
  DatabaseAutomationStore,
  readAutomations,
} from "~/database/automations";
import { DatabaseExecutionStore } from "~/database/executions";
import { DatabaseGrantStorage } from "~/database/grants";
import type { WorkspaceDatabase } from "~/database/managed";
import { defaultWorkspaceDatabase } from "~/database/managed";
import type { StoreDatabase } from "~/database/open";
import { DatabaseProviderStore, stateProviders } from "~/database/providers";
import { DatabaseRunStore } from "~/database/runs";
import { DatabaseSessionStore } from "~/database/sessions";
import type { WorkspaceStores } from "~/database/stores";
import {
  artifactBlobs,
  readArtifacts,
  workspaceStores,
} from "~/database/stores";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { DatabaseTriggerStore } from "~/database/triggers";
import { DatabaseUsageStore } from "~/database/usage";
import { Engine as PublishedEngine } from "~/entries/engine";
import { layout } from "~/layout";
import { configuredMonitorUrl } from "~/lib/automation/configured";
import { AutomationService } from "~/lib/automation/service";
import { MemoryAutomationStore } from "~/lib/automation/store";
import type { EngineOptions } from "~/lib/engine";
import { Engine } from "~/lib/engine";
import { environmentSnapshot, executionEnvironment } from "~/lib/environment";
import type { LogLevel, LogOrigin } from "~/lib/log";
import { allowedMountRoots } from "~/lib/managers/sandboxes";
import { localCatalogue } from "~/lib/managers/workspaces";
import { echoInstance } from "~/lib/models/echo";
import { ProviderConfiguration } from "~/lib/providers/configuration";
import type { RegisteredPlugin } from "~/lib/providers/plugins";
import { FIRST_PARTY_PLUGINS } from "~/lib/providers/plugins";
import { Registry } from "~/lib/registry";

/**
 * The engine as Marbles runs it. The machine is inspected and the flags are
 * read here, each instance the engine takes is built with the Marbles
 * default, and what the config declared is copied in. `--dry-run` is decided
 * here too: echo models, echoed git, a fake container runtime, and nothing
 * persisted.
 */

export interface CreateEngineOptions {
  /** The artifact store's directory, shared by every workspace. Omit for in-memory, which `--dry-run` always is. */
  readonly artifacts?: string;
  readonly askable?: boolean;
  readonly catalog: Catalog;
  /** Where the workspace's runs start and commands run; `root` when omitted. */
  readonly cwd?: string;
  /**
   * The Marbles database the host keeps open, which holds this workspace's
   * tasks, their recorded changes, its agent sessions, its workflow Runs,
   * its artifacts' records (their blob files stay under `artifacts`), its sandbox
   * containers and its workspace catalogue; the host closes it once the
   * engine is disposed. Without it, an engine given a state dir opens a
   * handle of its own at its first task, session or run call and closes it
   * when disposed, and keeps artifacts, containers and the catalogue in
   * memory; its provider configuration is read and written per call.
   * Under `dry` the engine gets neither and keeps everything in memory.
   */
  readonly database?: StoreDatabase;
  readonly dry: boolean;
  /** The machine environment and the workspace's Varlock values; the process's own when omitted. */
  readonly environment?: {
    readonly machine: Readonly<Record<string, string>>;
    readonly workspace: Readonly<Record<string, string>>;
  };
  /** The user's home; defaults to the OS home. */
  readonly home?: string;
  /** Definitions' own `log(...)` lines; to `print` when omitted. */
  readonly log?: (level: LogLevel, message: string, origin: LogOrigin) => void;
  /** Provider plugins that configuration may name; the first-party ones when omitted. */
  readonly plugins?: readonly RegisteredPlugin[];
  readonly print: (line: string) => void;
  /** A complete, ordered provider set that supersedes the stored configuration. */
  readonly providers?: readonly Provider[];
  /** The workspace root: the config's directory, or the cwd without one. */
  readonly root: string;
  /**
   * This workspace's state dir. Under `dry` the engine gets none, so nothing
   * is written there; omit it for an engine that persists nothing either way.
   */
  readonly stateDir?: string;
  /** The Marbles state root, holding the machine's provider configuration; the layout's when omitted. */
  readonly stateRoot?: string;
  /** Identity of this workspace's state; part of a declared artifact's id. */
  readonly workspaceId: string;
}

/** The one place `--dry-run` reaches the state dir: a dry engine persists nothing. */
function persisted(dry: boolean, stateDir: string | undefined) {
  return dry ? undefined : stateDir;
}

/**
 * What `define`, `schedule` and `monitor` are called on: an engine, or a
 * bare registry, which has no `observe`.
 */
type Declarable = Pick<Engine, "define" | "monitor" | "schedule"> &
  Partial<Pick<Engine, "observe">>;

/** Tell `target` everything the config declared, definitions first. */
export function declareCatalog(target: Declarable, catalog: Catalog): void {
  for (const definition of catalog.definitions.values()) {
    target.define(definition);
  }
  for (const record of catalog.schedules.values()) {
    target.schedule(record);
  }
  for (const record of catalog.monitors.values()) {
    target.monitor(record);
  }
  for (const { handler, source } of catalog.observers) {
    target.observe?.(source, handler);
  }
}

/** What an engine would trigger: the config's declarations and what agents created. */
export interface Triggers {
  /** The triggers agents created, read from the Marbles database. */
  readonly automations: AutomationService;
  /** What the config declared, and the step agent-created monitors share. */
  readonly registry: Registry;
}

/**
 * The triggers an engine created with these options would have, read
 * without building one, the automations read only from the Marbles
 * database at the state root: for commands that only list. Under
 * `--dry-run` no automation is read.
 */
export function readTriggers(
  catalog: Catalog,
  {
    dry,
    stateRoot,
    workspaceId,
  }: Pick<CreateEngineOptions, "dry" | "stateRoot" | "workspaceId">
): Triggers {
  const registry = new Registry();
  declareCatalog(registry, catalog);
  const automations = new AutomationService({
    allowHttp: configuredMonitorUrl(registry),
    registry,
    store: dry
      ? new MemoryAutomationStore()
      : readAutomations(stateRoot ?? layout().state, workspaceId),
  });
  return { automations, registry };
}

/**
 * The artifact system without the database: in memory, records and
 * bytes alike, for as long as the engine lasts. Nothing outside the
 * database could read records kept anywhere else.
 */
function artifactsInMemory(): Artifacts {
  return new ArtifactManager({ store: new InMemoryArtifactStore() });
}

/**
 * The engine's artifacts, and what `--dry-run` reads through to: in the
 * database's stores when the host gave one, their blob files in the
 * workspace's directory of the artifact store at `dir`; in memory
 * without one. A dry run writes to memory and reads what real runs left
 * in the database, read only.
 */
function artifactsFor(
  stores: WorkspaceStores | undefined,
  options: CreateEngineOptions
): Pick<EngineOptions, "artifactReads" | "artifacts"> {
  const { artifacts: dir, dry, workspaceId } = options;
  if (dry) {
    return {
      artifacts: artifactsInMemory(),
      ...(dir === undefined
        ? {}
        : {
            artifactReads: readArtifacts(
              options.stateRoot ?? layout().state,
              dir,
              workspaceId
            ),
          }),
    };
  }
  if (stores === undefined) {
    return { artifacts: artifactsInMemory() };
  }
  return {
    artifacts: new ArtifactManager({
      ...(dir === undefined
        ? {}
        : { files: blobFiles(artifactBlobs(dir, workspaceId)) }),
      store: stores.artifacts,
    }),
  };
}

/**
 * The models agents route to and the configuration that keeps them current:
 * a programmatic host's set as given, else the stored configuration, echoed
 * under `--dry-run`. With no configuration at all, nothing is guessed: the
 * set stays empty and opening a session fails with guidance.
 */
function modelsFor(options: CreateEngineOptions): {
  readonly models: ModelManager;
  readonly providers: ProviderConfiguration;
} {
  const models = new ModelManager();
  const echo = (provider: Provider) => echoInstance(provider, options.print);
  // Wrapped once: a fresh wrapper per load would retire, and so dispose, the host's instance.
  const fixed =
    options.dry && options.providers
      ? options.providers.map(echo)
      : options.providers;
  const providers = new ProviderConfiguration({
    environment: options.environment ?? {
      machine: environmentSnapshot(),
      workspace: {},
    },
    ...(options.dry ? { echo } : {}),
    ...(fixed ? { fixed } : {}),
    models,
    ...(options.dry ? { readOnly: true } : {}),
    plugins: options.plugins ?? FIRST_PARTY_PLUGINS,
    store:
      options.database === undefined || options.dry
        ? stateProviders(options.stateRoot ?? layout().state)
        : new DatabaseProviderStore({ database: options.database }),
    ...(options.stateDir
      ? {
          workspace: {
            dir: options.stateDir,
            id: options.workspaceId,
            root: options.root,
          },
        }
      : {}),
  });
  // A programmatic host's set is there at once; the stored configuration
  // is read when the engine starts (`refresh`).
  if (providers.configured) {
    providers.load();
  }
  return { models, providers };
}

/**
 * Where the engine keeps the workspace's tasks, agent sessions, workflow
 * Runs and trigger state: in the host's database, scoped by the workspace id; without one
 * but with a state dir, in a handle on the database the engine opens
 * itself (`own`), which it closes once disposed; with neither, in memory.
 */
function recordsFor(
  state: string | undefined,
  database: StoreDatabase | undefined,
  { root, workspaceId }: CreateEngineOptions
): Pick<
  EngineOptions,
  | "activityStore"
  | "approvals"
  | "automationStore"
  | "executionStore"
  | "grants"
  | "records"
  | "runs"
  | "sessions"
  | "triggers"
  | "usageStore"
> & {
  readonly own?: WorkspaceDatabase;
} {
  if (database !== undefined) {
    const scope = workspaceId;
    return {
      activityStore: new DatabaseActivityStore({ database, scope }),
      approvals: new DatabaseDeferredApprovalStore({ database, scope }),
      automationStore: new DatabaseAutomationStore({ database, scope }),
      executionStore: new DatabaseExecutionStore({ database, scope }),
      grants: new DatabaseGrantStorage({ database, scope }),
      records: new DatabaseWorkspaceRecords({ database, scope }),
      runs: new DatabaseRunStore({ database, scope }),
      sessions: new DatabaseSessionStore({ database, scope }),
      triggers: new DatabaseTriggerStore({ database, scope }),
      usageStore: new DatabaseUsageStore({ database, scope }),
    };
  }
  if (state === undefined) {
    return { sessions: new InMemorySessionStore() };
  }
  const own = defaultWorkspaceDatabase(state, root, workspaceId);
  return {
    activityStore: own.activityStore,
    approvals: own.approvals,
    automationStore: own.automations,
    executionStore: own.executions,
    grants: own.grants,
    own,
    records: own.records,
    runs: own.runs,
    sessions: own.sessions,
    triggers: own.triggers,
    usageStore: own.usage,
  };
}

/**
 * The published `Engine` over a database handle it opened itself, which it
 * closes after everything else it holds: its agents and interactions may
 * still write a session once its records are closed.
 */
class OwnDatabaseEngine extends PublishedEngine {
  readonly #database: WorkspaceDatabase;

  constructor(options: EngineOptions, database: WorkspaceDatabase) {
    super(options);
    this.#database = database;
  }

  override async dispose(): Promise<void> {
    try {
      await super.dispose();
    } finally {
      await this.#database.close();
    }
  }
}

/**
 * Started at the first sandbox: the runtime is optional and slow to start.
 * Its rows go to `store`, the database's when the host gave one, else
 * memory.
 */
function containersFor(
  { catalog, dry, print, root, workspaceId }: CreateEngineOptions,
  worktreeHome: string,
  store: ContainerStore | undefined
): () => Promise<Containers> {
  // `--dry-run` echoes every command a sandbox would run, like git and the
  // models, so a config with sandboxes runs end to end with nothing installed.
  const runtime = () =>
    dry
      ? Promise.resolve(createFakeContainerRuntime({ exec: echoExec(print) }))
      : import("@foundry/sandbox/container/microsandbox-runtime").then(
          ({ createMicrosandboxRuntime }) => createMicrosandboxRuntime()
        );
  return async () => {
    mkdirSync(worktreeHome, { recursive: true });
    const declared = [...catalog.workspaces].map((path) => resolve(root, path));
    return createContainers({
      allowedMountRoots: allowedMountRoots([root, worktreeHome, ...declared]),
      instanceLabel: `marbles-${workspaceId}`,
      runtime: await runtime(),
      store: store ?? createMemoryContainerStore(),
    });
  };
}

/** Build each instance, hand them to a new engine, and declare the config to it. Not yet started. */
export function createEngine(options: CreateEngineOptions): Engine {
  const { catalog, dry, print, root, workspaceId } = options;
  const home = options.home ?? homedir();
  const state = persisted(dry, options.stateDir);
  // Its sandboxes may mount what is cut there; see `containersFor`.
  const worktrees = Engine.worktreesFor(state);
  const database = dry ? undefined : options.database;
  const { own, ...kept } = recordsFor(state, database, options);
  const stores =
    database === undefined ? undefined : workspaceStores(database, workspaceId);
  const git = dry ? { run: echoGit(print) } : {};
  // The class the package publishes, so a host's engine is that `Engine`.
  const engineOptions: EngineOptions = {
    ...artifactsFor(stores, options),
    askable: options.askable,
    containers: containersFor(options, worktrees, stores?.containers),
    dry,
    git,
    home,
    ...(options.log ? { log: options.log } : {}),
    ...modelsFor(options),
    print,
    ...kept,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.environment === undefined
      ? {}
      : { environment: executionEnvironment(options.environment) }),
    root,
    state,
    workspaceId,
    ...(stores === undefined
      ? {}
      : { workspaces: localCatalogue(git, stores.workspaces) }),
    worktrees,
  };
  const engine =
    own === undefined
      ? new PublishedEngine(engineOptions)
      : new OwnDatabaseEngine(engineOptions, own);
  declareCatalog(engine, catalog);
  return engine;
}

/**
 * The runtime a definition's instance uses in a script no host loaded: the
 * detected CLI harnesses, the machine's provider configuration, and the
 * current directory as the workspace; its artifacts are in memory, and
 * nothing is persisted. Not started; no run is launched through it.
 */
export function createDefaultEngine(): Engine {
  const machine = layout();
  const { id, root } = machine.workspace(process.cwd());
  return createEngine({
    artifacts: machine.artifacts,
    catalog: new Catalog(),
    dry: false,
    print: (line) => {
      process.stderr.write(`${line}\n`);
    },
    root,
    stateRoot: machine.state,
    workspaceId: id,
  });
}

/** Prints the command a sandbox would run and returns a clean exit. */
function echoExec(print: (line: string) => void): (
  command: readonly string[]
) => {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  return (command) => {
    print(`[sandbox] ${showArgv(command)}`);
    return { exitCode: 0, stderr: "", stdout: "" };
  };
}

/** Prints the git it would run and runs nothing. */
export function echoGit(print: (line: string) => void): GitRun {
  return (cwd, args) => {
    print(`[git] ${cwd}: git ${args.join(" ")}`);
    return Promise.resolve("");
  };
}
