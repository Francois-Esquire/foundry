import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SessionStore } from "@foundry/agents/store";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import type { ArtifactSubstrate } from "@foundry/artifacts";
import { Artifacts } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import type { ArtifactStore } from "@foundry/artifacts/store";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import type { GrantDocumentStorage } from "@foundry/lib/authorization/document";
import type { Provider } from "@foundry/models";
import { Models } from "@foundry/models";
import { DEFAULT_POOL } from "@foundry/queue";
import type { Containers } from "@foundry/sandbox";
import { createContainers } from "@foundry/sandbox/node";
import type { ContainerStore } from "@foundry/sandbox/store";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import type { GitRun } from "@foundry/workspaces/node/git";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import { Catalog } from "~/authoring/catalog";
import {
  dispose,
  hasDefaultRuntime,
  setDefaultRoot,
  setDefaultRuntime,
} from "~/authoring/runtime";
import type { LinksKept } from "~/database/artifact-links";
import { keepingLinks } from "~/database/artifact-links";
import { ChangeRecorder } from "~/database/changes";
import { artifactBlobs, readArtifacts } from "~/database/local-artifacts";
import type { WorkspaceDatabase } from "~/database/managed";
import { defaultWorkspaceDatabase } from "~/database/managed";
import type { StoreDatabase } from "~/database/open";
import { providerStoreForState, readAutomations } from "~/database/open";
import { DatabaseProviderStore } from "~/database/providers";
import type { WorkspaceStores } from "~/database/stores";
import { assembleSqliteWorkspaceStores } from "~/database/stores";
import { Engine as PublishedEngine } from "~/entries/engine";
import { layout } from "~/layout";
import { showArgv } from "~/lib/argv";
import { configuredMonitorUrl } from "~/lib/automation/configured";
import { AutomationService } from "~/lib/automation/service";
import type { AutomationStore } from "~/lib/automation/store";
import { MemoryAutomationStore } from "~/lib/automation/store";
import type { EngineOptions } from "~/lib/engine";
import { Engine } from "~/lib/engine";
import { environmentSnapshot } from "~/lib/environment";
import type { WorkspaceRecords } from "~/lib/events/records";
import { causingRun } from "~/lib/events/records";
import { sourceKey } from "~/lib/events/source";
import type { PoolConfig } from "~/lib/execution-record";
import type { ExecutionStore } from "~/lib/execution-store";
import { inTurn } from "~/lib/in-turn";
import type { LogLevel, LogOrigin } from "~/lib/log";
import { allowedMountRoots } from "~/lib/managers/sandboxes";
import { localWorkspaces } from "~/lib/managers/workspaces";
import { echoInstance } from "~/lib/models/echo";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
import type { OwnerLiveness } from "~/lib/owner-liveness";
import { ProviderConfiguration } from "~/lib/providers/configuration";
import { DEFAULT_PROVIDERS } from "~/lib/providers/defaults";
import type { ProviderPlugin } from "~/lib/providers/plugins";
import type { ProviderStore } from "~/lib/providers/store";
import { MemoryProviderStore } from "~/lib/providers/store";
import { Registry } from "~/lib/registry";
import type { RunQueueOptions } from "~/lib/run-queue";
import type { RunStore } from "~/lib/run-store";
import type { ActivityStore } from "~/lib/sandbox/activities";
import type { DeferredApprovalStore } from "~/lib/sandbox/deferred-approvals";
import { containerHolder } from "~/lib/sandbox/holders";
import type { RunOutputSink } from "~/lib/state/output";
import type { TriggerStore } from "~/lib/trigger-store";
import type { UsageStore } from "~/lib/usage-store";
import { initializeUsage } from "~/workspace/node-usage";

export const DEFAULT_HOSTED_POOL_LIMIT = 4;

export interface WorkspaceStoreBundle {
  readonly activities?: ActivityStore;
  readonly approvals?: DeferredApprovalStore;
  readonly artifacts?: ArtifactStore;
  readonly automations?: AutomationStore;
  readonly containers?: ContainerStore;
  readonly executions?: ExecutionStore;
  readonly grants?: GrantDocumentStorage;
  readonly providers?: ProviderStore;
  readonly records?: WorkspaceRecords;
  readonly runs?: RunStore;
  readonly sessions?: SessionStore;
  readonly triggers?: TriggerStore;
  readonly usage?: UsageStore;
  readonly workspaces?: WorkspaceStore;
}

export interface CreateEngineOptions {
  readonly artifacts?: string;
  readonly askable?: boolean;
  readonly catalog: Catalog;
  readonly createQueueClient?: RunQueueOptions["createClient"];
  readonly cwd?: string;
  readonly database?: StoreDatabase;
  readonly databaseFile?: string;
  readonly dry: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly home?: string;
  readonly leaseTtlMs?: number;
  readonly liveness?: OwnerLiveness;
  readonly log?: (level: LogLevel, message: string, origin: LogOrigin) => void;
  readonly outputSink?: RunOutputSink;
  readonly plugins?: readonly ProviderPlugin[];
  readonly pools?: Readonly<Record<string, PoolConfig>>;
  readonly print: (line: string) => void;
  readonly providers?: readonly Provider[];
  readonly root: string;
  readonly spawned?: string;
  readonly stateDir?: string;
  readonly stateRoot?: string;
  readonly stores?: WorkspaceStoreBundle;
  readonly workspaceId: string;
}

function declareDefinitions(target: Engine | Registry, catalog: Catalog): void {
  if (target instanceof Registry) {
    for (const [name, definition] of catalog.definitions) {
      const origin = catalog.originOf(name);
      target.define(definition, {
        name,
        ...(origin === undefined ? {} : { origin }),
      });
    }
    return;
  }
  target.bindCatalog(catalog);
  for (const [name, definition] of catalog.definitions) {
    const origin = catalog.originOf(name);
    target.define(definition, catalog.poolForDefinition(name), {
      name,
      ...(origin === undefined ? {} : { origin }),
    });
  }
}

export function declareCatalog(
  target: Engine | Registry,
  catalog: Catalog
): void {
  declareDefinitions(target, catalog);
  for (const record of catalog.schedules.values()) {
    target.schedule(record);
  }
  for (const record of catalog.monitors.values()) {
    target.monitor(record);
  }
  if (target instanceof Registry) {
    return;
  }
  for (const { handler, name, source, timeout, types } of catalog.observers) {
    target.observe(source, handler, {
      name,
      ...(timeout === undefined ? {} : { timeout }),
      ...(types === undefined ? {} : { types }),
    });
  }
}

export interface Triggers {
  readonly automations: AutomationService;
  readonly registry: Registry;
}

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

function artifactsInMemory(): ArtifactSubstrate {
  return new Artifacts({ store: new MemoryArtifactStore() });
}

function artifactsFor(
  stores: WorkspaceStores | undefined,
  injected: ArtifactStore | undefined,
  options: CreateEngineOptions
): Pick<EngineOptions, "artifactReads" | "artifacts"> & {
  readonly links?: LinksKept;
} {
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
  if (injected !== undefined) {
    return {
      artifacts: new Artifacts({
        ...(dir === undefined
          ? {}
          : { files: blobFiles(artifactBlobs(dir, workspaceId)) }),
        store: injected,
      }),
    };
  }
  if (stores === undefined) {
    return { artifacts: artifactsInMemory() };
  }
  const { database, print } = options;
  const kept =
    dir === undefined || database === undefined
      ? undefined
      : keepingLinks(stores.artifacts, {
          artifacts: dir,
          database,
          owner: workspaceId,
          report: print,
          state: options.stateRoot ?? layout().state,
        });
  return {
    artifacts: new Artifacts({
      ...(dir === undefined
        ? {}
        : { files: blobFiles(artifactBlobs(dir, workspaceId)) }),
      store: kept ?? stores.artifacts,
    }),
    ...(kept === undefined ? {} : { links: kept }),
  };
}

function pluginsFor({
  catalog,
  plugins = DEFAULT_PROVIDERS,
}: CreateEngineOptions): readonly ProviderPlugin[] {
  const chosen = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  for (const plugin of catalog.providers.values()) {
    const taken = chosen.get(plugin.id);
    if (taken !== undefined && taken !== plugin) {
      throw new Error(
        `provider "${plugin.id}" is defined by the workspace's source and is also one of the engine's own plugins; keep one of them`
      );
    }
    chosen.set(plugin.id, plugin);
  }
  return [...chosen.values()];
}

function providerStoreFor(
  options: CreateEngineOptions,
  fallback?: ProviderStore
): ProviderStore {
  if (!options.dry && options.stores?.providers !== undefined) {
    return options.stores.providers;
  }
  if (
    !options.dry &&
    options.stores !== undefined &&
    options.database === undefined &&
    options.stateRoot === undefined &&
    options.stateDir === undefined
  ) {
    return new MemoryProviderStore();
  }
  if (options.database === undefined || options.dry) {
    return providerStoreForState(options.stateRoot ?? layout().state);
  }
  return fallback ?? new DatabaseProviderStore({ database: options.database });
}

function modelsFor(
  options: CreateEngineOptions,
  fallback?: ProviderStore
): {
  readonly models: Models;
  readonly providers: ProviderConfiguration;
} {
  const models = new Models();
  const echo = (provider: Provider) => echoInstance(provider, options.print);
  const fixed =
    options.dry && options.providers
      ? options.providers.map(echo)
      : options.providers;
  const providers = new ProviderConfiguration({
    environment: options.environment ?? environmentSnapshot(),
    ...(options.dry ? { echo } : {}),
    ...(fixed ? { fixed } : {}),
    models,
    ...(options.dry ? { readOnly: true } : {}),
    plugins: pluginsFor(options),
    store: providerStoreFor(options, fallback),
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
  if (providers.configured) {
    providers.load();
  }
  return { models, providers };
}

function injectedRecords(injected: WorkspaceStoreBundle) {
  return {
    ...(injected.activities === undefined
      ? {}
      : { activityStore: injected.activities }),
    ...(injected.approvals === undefined
      ? {}
      : { approvals: injected.approvals }),
    ...(injected.automations === undefined
      ? {}
      : { automationStore: injected.automations }),
    ...(injected.executions === undefined
      ? {}
      : { executionStore: injected.executions }),
    ...(injected.grants === undefined ? {} : { grants: injected.grants }),
    ...(injected.records === undefined ? {} : { records: injected.records }),
    ...(injected.runs === undefined ? {} : { runs: injected.runs }),
    ...(injected.sessions === undefined ? {} : { sessions: injected.sessions }),
    ...(injected.triggers === undefined ? {} : { triggers: injected.triggers }),
    ...(injected.usage === undefined ? {} : { usageStore: injected.usage }),
  };
}

function recordsFor(
  state: string | undefined,
  injected: WorkspaceStoreBundle | undefined,
  { root, workspaceId }: CreateEngineOptions,
  assembled: ReturnType<typeof assembleSqliteWorkspaceStores> | undefined
): Pick<
  EngineOptions,
  | "activityStore"
  | "approvals"
  | "automationStore"
  | "executionStore"
  | "grants"
  | "records"
  | "recoveryLog"
  | "runs"
  | "sessions"
  | "triggers"
  | "usageStore"
> & {
  readonly own?: WorkspaceDatabase;
} {
  const overrides = injected === undefined ? {} : injectedRecords(injected);
  if (assembled !== undefined) {
    return {
      activityStore: assembled.activities,
      approvals: assembled.approvals,
      automationStore: assembled.automations,
      executionStore: assembled.executions,
      grants: assembled.grants,
      records: assembled.records,
      recoveryLog: assembled.recoveryLog,
      runs: assembled.runs,
      sessions: assembled.sessions,
      triggers: assembled.triggers,
      usageStore: assembled.usage,
      ...overrides,
    };
  }
  if (injected !== undefined && state === undefined) {
    return { sessions: new MemorySessionStore(), ...overrides };
  }
  if (state === undefined) {
    return { sessions: new MemorySessionStore() };
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
    recoveryLog: own.recoveryLog,
    runs: own.runs,
    sessions: own.sessions,
    triggers: own.triggers,
    usageStore: own.usage,
    ...overrides,
  };
}

const LINK_DRAIN_MS = 5000;

function engineOver(
  options: EngineOptions,
  own: WorkspaceDatabase | undefined,
  links: LinksKept | undefined,
  useDirectEngine: boolean
): Engine {
  if (own !== undefined) {
    return new OwnDatabaseEngine(options, own);
  }
  if (links !== undefined) {
    return new LinkKeepingEngine(options, links);
  }
  return useDirectEngine ? new Engine(options) : new PublishedEngine(options);
}

class LinkKeepingEngine extends PublishedEngine {
  readonly #links: LinksKept;
  #disposed: Promise<void> | undefined;

  constructor(options: EngineOptions, links: LinksKept) {
    super(options);
    this.#links = links;
  }

  override dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      try {
        await super.dispose();
      } finally {
        await this.#links.drainLinks(LINK_DRAIN_MS);
      }
    })();
    return this.#disposed;
  }
}

class OwnDatabaseEngine extends PublishedEngine {
  readonly #database: WorkspaceDatabase;

  constructor(options: EngineOptions, database: WorkspaceDatabase) {
    super(options);
    this.#database = database;
  }

  override dispose(): Promise<void> {
    return inTurn(
      () => super.dispose(),
      () => this.#database.close(),
      "Failed to dispose the engine and close its database"
    );
  }
}

function containersFor(
  { catalog, dry, liveness, print, root, workspaceId }: CreateEngineOptions,
  worktreeHome: string,
  store: ContainerStore | undefined
): () => Promise<Containers> {
  const runtime = () =>
    dry
      ? Promise.resolve(createFakeContainerRuntime({ exec: echoExec(print) }))
      : import("@foundry/sandbox/node/microsandbox").then(
          ({ createMicrosandboxRuntime }) => createMicrosandboxRuntime()
        );
  return async () => {
    mkdirSync(worktreeHome, { recursive: true });
    const declared = [...catalog.workspaces].map((path) => resolve(root, path));
    return createContainers({
      allowedMountRoots: allowedMountRoots([root, worktreeHome, ...declared]),
      holder: containerHolder(liveness),
      instanceLabel: `marbles-${workspaceId}`,
      report: (line) => print(`[sandbox] ${line}`),
      runtime: await runtime(),
      store: store ?? new MemoryContainerStore(),
    });
  };
}

function realPath(file: string | undefined): string | undefined {
  if (file === undefined) {
    return;
  }
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

function hostRuntimeOptions(
  options: CreateEngineOptions
): Pick<
  EngineOptions,
  "createQueueClient" | "leaseTtlMs" | "liveness" | "outputSink"
> {
  return {
    ...(options.createQueueClient === undefined
      ? {}
      : { createQueueClient: options.createQueueClient }),
    ...(options.leaseTtlMs === undefined
      ? {}
      : { leaseTtlMs: options.leaseTtlMs }),
    liveness: options.liveness ?? NODE_OWNER_LIVENESS,
    ...(options.outputSink === undefined
      ? {}
      : { outputSink: options.outputSink }),
  };
}

export function createEngine(options: CreateEngineOptions): Engine {
  const { catalog, dry, print, root, workspaceId } = options;
  const home = options.home ?? homedir();
  const { spawned, state } = Engine.persistence({
    dry,
    ...(options.spawned === undefined ? {} : { spawned: options.spawned }),
    ...(options.stateDir === undefined ? {} : { state: options.stateDir }),
  });
  const worktrees = Engine.worktreesFor(state);
  const database = dry ? undefined : options.database;
  const injected = dry ? undefined : options.stores;
  const assembled = databaseStoresFor(options, database);
  const { own, ...kept } = recordsFor(state, injected, options, assembled);
  const dbStores =
    assembled === undefined
      ? undefined
      : {
          artifacts: assembled.artifactStore,
          containers: assembled.containers,
          workspaces: assembled.workspaces,
        };
  const containerStore = injected?.containers ?? dbStores?.containers;
  const workspaceStore = injected?.workspaces ?? dbStores?.workspaces;
  const git = dry ? { run: echoGit(print) } : {};
  const { links, ...artifacts } = artifactsFor(
    dbStores,
    injected?.artifacts,
    options
  );
  const engineOptions: EngineOptions = {
    pools: {
      [DEFAULT_POOL]: DEFAULT_HOSTED_POOL_LIMIT,
      ...catalog.poolRecords(),
      ...options.pools,
    },
    ...artifacts,
    askable: options.askable,
    catalog,
    ...(containerStore === undefined ? {} : { containerRows: containerStore }),
    containers: containersFor(options, worktrees, containerStore),
    dry,
    git,
    home,
    ...hostRuntimeOptions(options),
    ...(options.log ? { log: options.log } : {}),
    ...modelsFor(options, assembled?.providers),
    print,
    ...kept,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    root,
    ...(spawned === undefined ? {} : { spawned }),
    state,
    workspaceId,
    ...(workspaceStore === undefined
      ? {}
      : { workspaces: localWorkspaces(git, workspaceStore) }),
    worktrees,
  };
  const engine = engineOver(
    engineOptions,
    own,
    links,
    injected !== undefined && database === undefined && state === undefined
  );
  declareCatalog(engine, catalog);
  unrecordedObservers(
    catalog,
    recordedSources(database, state, injected),
    print
  );
  return engine;
}

function recordedSources(
  database: StoreDatabase | undefined,
  state: string | undefined,
  injected: WorkspaceStoreBundle | undefined
): ReadonlySet<string> | "all" {
  if (database !== undefined || injected !== undefined) {
    return "all";
  }
  return new Set(
    state === undefined ? ["tasks"] : ["runs", "sessions", "tasks"]
  );
}

function unrecordedObservers(
  catalog: Catalog,
  recorded: ReadonlySet<string> | "all",
  print: (line: string) => void
): void {
  if (recorded === "all") {
    return;
  }
  for (const observer of catalog.observers) {
    const key = sourceKey(observer.source);
    if (key !== undefined && !recorded.has(key)) {
      print(
        `[observe] ${observer.name} (${key}) receives nothing here: this engine keeps its ${key} without recording their changes`
      );
    }
  }
}

function createDefaultEngine({ dry }: { readonly dry: boolean }): Engine {
  const machine = layout();
  const { id, root } = machine.workspace(process.cwd());
  return createEngine({
    artifacts: machine.artifacts,
    catalog: new Catalog(),
    dry,
    plugins: [...DEFAULT_PROVIDERS],
    print: (line) => {
      process.stderr.write(`${line}\n`);
    },
    root,
    stateRoot: machine.state,
    workspaceId: id,
  });
}

export function installDefaultRuntime(): void {
  setDefaultRoot(() => process.cwd());
  if (hasDefaultRuntime()) {
    return;
  }
  setDefaultRuntime(async ({ dry }) => {
    const [engine] = await Promise.all([
      Promise.resolve(createDefaultEngine({ dry })),
      initializeUsage(),
    ]);
    const problems =
      (await engine.providers
        ?.refresh()
        .catch((error: unknown) => [String(error)])) ?? [];
    for (const problem of problems) {
      process.stderr.write(`[providers] ${problem}\n`);
    }
    process.once("beforeExit", () => {
      dispose().catch(() => undefined);
    });
    return engine;
  });
}

installDefaultRuntime();

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

export function echoGit(print: (line: string) => void): GitRun {
  return (cwd, args) => {
    print(`[git] ${cwd}: git ${args.join(" ")}`);
    return Promise.resolve("");
  };
}

function databaseStoresFor(
  options: CreateEngineOptions,
  database: StoreDatabase | undefined
) {
  return database === undefined
    ? undefined
    : assembleSqliteWorkspaceStores(database, options.workspaceId, {
        changes: new ChangeRecorder(options.workspaceId, {
          causingRun: () => causingRun() ?? undefined,
        }),
        liveness: options.liveness ?? NODE_OWNER_LIVENESS,
        ...(options.artifacts === undefined
          ? {}
          : {
              blobs: blobFiles(
                artifactBlobs(options.artifacts, options.workspaceId)
              ),
            }),
        location: realPath(options.databaseFile),
      });
}
