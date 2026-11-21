import { mkdirSync, realpathSync } from "node:fs";
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
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import type { GitRun } from "@foundry/workspaces/git";
import { Catalog } from "~/authoring/catalog";
import { DatabaseActivityStore } from "~/database/activities";
import { DatabaseDeferredApprovalStore } from "~/database/approvals";
import type { LinksKept } from "~/database/artifact-links";
import { keepingLinks } from "~/database/artifact-links";
import {
  DatabaseAutomationStore,
  readAutomations,
} from "~/database/automations";
import type { ChangeRecorder } from "~/database/changes";
import { DatabaseExecutionStore } from "~/database/executions";
import { DatabaseGrantStorage } from "~/database/grants";
import type { WorkspaceDatabase } from "~/database/managed";
import { defaultWorkspaceDatabase } from "~/database/managed";
import type { StoreDatabase } from "~/database/open";
import { DatabaseProviderStore } from "~/database/providers";
import { DatabaseRecoveryLog } from "~/database/recoveries";
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
import { environmentSnapshot } from "~/lib/environment";
import { sourceKey } from "~/lib/events/source";
import { inTurn } from "~/lib/in-turn";
import type { LogLevel, LogOrigin } from "~/lib/log";
import { allowedMountRoots } from "~/lib/managers/sandboxes";
import { localCatalogue } from "~/lib/managers/workspaces";
import { echoInstance } from "~/lib/models/echo";
import { ProviderConfiguration } from "~/lib/providers/configuration";
import type { RegisteredPlugin } from "~/lib/providers/plugins";
import { FIRST_PARTY_PLUGINS } from "~/lib/providers/plugins";
import { Registry } from "~/lib/registry";
import { containerHolder } from "~/lib/sandbox/holders";

export interface CreateEngineOptions {
  readonly artifacts?: string;
  readonly askable?: boolean;
  readonly catalog: Catalog;
  readonly cwd?: string;
  readonly database?: StoreDatabase;
  readonly databaseFile?: string;
  readonly dry: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly home?: string;
  readonly log?: (level: LogLevel, message: string, origin: LogOrigin) => void;
  readonly plugins?: readonly RegisteredPlugin[];
  readonly print: (line: string) => void;
  readonly providers?: readonly Provider[];
  readonly root: string;
  readonly spawned?: string;
  readonly stateDir?: string;
  readonly stateRoot?: string;
  readonly workspaceId: string;
}

type Declarable = Pick<Engine, "define" | "monitor" | "schedule"> &
  Partial<Pick<Engine, "observe">>;

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
  for (const { handler, name, source, timeout, types } of catalog.observers) {
    target.observe?.(source, handler, {
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

function artifactsInMemory(): Artifacts {
  return new ArtifactManager({ store: new InMemoryArtifactStore() });
}

function artifactsFor(
  stores: WorkspaceStores | undefined,
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
    artifacts: new ArtifactManager({
      ...(dir === undefined
        ? {}
        : { files: blobFiles(artifactBlobs(dir, workspaceId)) }),
      store: kept ?? stores.artifacts,
    }),
    ...(kept === undefined ? {} : { links: kept }),
  };
}

function modelsFor(options: CreateEngineOptions): {
  readonly models: ModelManager;
  readonly providers: ProviderConfiguration;
} {
  const models = new ModelManager();
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
    plugins: options.plugins ?? FIRST_PARTY_PLUGINS,
    store:
      options.database === undefined || options.dry
        ? DatabaseProviderStore.forState(options.stateRoot ?? layout().state)
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
  if (providers.configured) {
    providers.load();
  }
  return { models, providers };
}

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
  | "recoveryLog"
  | "runs"
  | "sessions"
  | "triggers"
  | "usageStore"
> & {
  readonly changes?: ChangeRecorder;
  readonly own?: WorkspaceDatabase;
} {
  if (database !== undefined) {
    const scope = workspaceId;
    const records = new DatabaseWorkspaceRecords({ database, scope });
    const { changes } = records;
    return {
      activityStore: new DatabaseActivityStore({ database, scope }),
      approvals: new DatabaseDeferredApprovalStore({ database, scope }),
      automationStore: new DatabaseAutomationStore({ database, scope }),
      changes,
      executionStore: new DatabaseExecutionStore({ database, scope }),
      grants: new DatabaseGrantStorage({ database, scope }),
      records,
      recoveryLog: new DatabaseRecoveryLog({ database, scope }),
      runs: new DatabaseRunStore({ changes, database, scope }),
      sessions: new DatabaseSessionStore({ changes, database, scope }),
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
    recoveryLog: own.recoveryLog,
    runs: own.runs,
    sessions: own.sessions,
    triggers: own.triggers,
    usageStore: own.usage,
  };
}

const LINK_DRAIN_MS = 5000;

function engineOver(
  options: EngineOptions,
  own: WorkspaceDatabase | undefined,
  links: LinksKept | undefined
): PublishedEngine {
  if (own !== undefined) {
    return new OwnDatabaseEngine(options, own);
  }
  return links === undefined
    ? new PublishedEngine(options)
    : new LinkKeepingEngine(options, links);
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
  { catalog, dry, print, root, workspaceId }: CreateEngineOptions,
  worktreeHome: string,
  store: ContainerStore | undefined
): () => Promise<Containers> {
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
      holder: containerHolder(),
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
  const { changes, own, ...kept } = recordsFor(state, database, options);
  const stores =
    database === undefined
      ? undefined
      : workspaceStores(database, workspaceId, {
          changes,
          location: realPath(options.databaseFile),
        });
  const git = dry ? { run: echoGit(print) } : {};
  const { links, ...artifacts } = artifactsFor(stores, options);
  const engineOptions: EngineOptions = {
    ...artifacts,
    askable: options.askable,
    ...(stores === undefined ? {} : { containerRows: stores.containers }),
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
      : { environment: options.environment }),
    root,
    ...(spawned === undefined ? {} : { spawned }),
    state,
    workspaceId,
    ...(stores === undefined
      ? {}
      : { workspaces: localCatalogue(git, stores.workspaces) }),
    worktrees,
  };
  const engine = engineOver(engineOptions, own, links);
  declareCatalog(engine, catalog);
  unrecordedObservers(catalog, recordedSources(database, state), print);
  return engine;
}

function recordedSources(
  database: StoreDatabase | undefined,
  state: string | undefined
): ReadonlySet<string> | "all" {
  if (database !== undefined) {
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

export function createDefaultEngine({
  dry,
}: {
  readonly dry: boolean;
}): Engine {
  const machine = layout();
  const { id, root } = machine.workspace(process.cwd());
  return createEngine({
    artifacts: machine.artifacts,
    catalog: new Catalog(),
    dry,
    print: (line) => {
      process.stderr.write(`${line}\n`);
    },
    root,
    stateRoot: machine.state,
    workspaceId: id,
  });
}

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
