import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "@foundry/agents/authorization";
import type { SessionStore } from "@foundry/agents/store";
import { InMemorySessionStore } from "@foundry/agents/store/memory";
import type { Artifacts as ArtifactSubstrate } from "@foundry/artifacts";
import { Config } from "@foundry/lib/config";
import type { GrantDocumentStorage } from "@foundry/lib/config/authorization/document";
import {
  type ProcessIdentity,
  sameProcess,
  thisProcess,
} from "@foundry/lib/process-identity";
import type { ModelManager } from "@foundry/models";
import type { AirplaneMode } from "@foundry/models/airplane";
import { airplaneMode } from "@foundry/models/airplane";
import type { ModelsDevHold } from "@foundry/models/catalog/models-dev-source";
import { holdModelsDev } from "@foundry/models/catalog/models-dev-source";
import type { Containers } from "@foundry/sandbox/container/containers";
import type { ContainerStore } from "@foundry/sandbox/store";
import type { TaskStore } from "@foundry/tasks";
import { ExecutionCoordinator } from "@foundry/workflows";
import type { ChannelMessage } from "@foundry/workflows/channels";
import { contributeQueueConfig } from "@foundry/workflows/config";
import type { BaseContext } from "@foundry/workflows/executable";
import type { Factory } from "@foundry/workflows/orchestrator";
import { Orchestrator } from "@foundry/workflows/orchestrator";
import type { RunRecord } from "@foundry/workflows/schema";
import { configuredMonitorUrl } from "~/lib/automation/configured";
import { AutomationService } from "~/lib/automation/service";
import type { AutomationStore } from "~/lib/automation/store";
import { MemoryAutomationStore } from "~/lib/automation/store";
import type { Bindings } from "~/lib/bindings";
import { harnessOf } from "~/lib/cli-harnesses";
import { commandRunner } from "~/lib/command";
import {
  CrashRecovery,
  type RecoveryLog,
  type RecoveryReport,
} from "~/lib/crash-recovery";
import type { AnyDefinition } from "~/lib/definition";
import { environmentSnapshot } from "~/lib/environment";
import type { ObserveOptions } from "~/lib/events/delivery";
import { Delivery } from "~/lib/events/delivery";
import type { WorkspaceRecords } from "~/lib/events/records";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import type { Fact, Handler, Source } from "~/lib/events/source";
import type { ExecutionContext } from "~/lib/execution-context";
import { SETTLED_EXECUTION_STATUSES } from "~/lib/execution-statuses";
import type { ExecutionStore } from "~/lib/execution-store";
import { MemoryExecutionStore } from "~/lib/execution-store";
import type {
  ExecutionRun,
  ExecutionRuns,
  QueueSettings,
} from "~/lib/executions";
import { DEFAULT_QUEUE, Executions } from "~/lib/executions";
import { selectExecutor } from "~/lib/executor";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { FeedPublisher } from "~/lib/feed/publish";
import { feedPublisher } from "~/lib/feed/publish";
import type { FeedReader } from "~/lib/feed/read";
import { feedReader } from "~/lib/feed/read";
import type { FeedRouter } from "~/lib/feed/route";
import { feedRouter, movedAway, QuestionMovingError } from "~/lib/feed/route";
import type { Dispatched } from "~/lib/held-runs";
import { HeldRuns } from "~/lib/held-runs";
import type {
  DispatchedRun,
  Launched,
  LaunchOptions,
  QueuedTake,
} from "~/lib/launcher";
import { Launcher } from "~/lib/launcher";
import { createLog, type LogLevel, type LogOrigin } from "~/lib/log";
import { AgentsManager } from "~/lib/managers/agents";
import { ArtifactsManager } from "~/lib/managers/artifacts";
import { SandboxesManager } from "~/lib/managers/sandboxes";
import { skillResolver } from "~/lib/managers/skills";
import type { Catalogue, GitOptions } from "~/lib/managers/workspaces";
import { localCatalogue, WorkspacesManager } from "~/lib/managers/workspaces";
import type { ProviderConfiguration } from "~/lib/providers/configuration";
import type { DefinitionEntry, MonitorRecord } from "~/lib/registry";
import { Registry } from "~/lib/registry";
import { RunListing } from "~/lib/run-listing";
import {
  adoptParkedRun,
  adoptParkedRuns,
  workflowStatuses,
} from "~/lib/run-recovery";
import type { ReadonlyRunScopes, RecordedScope } from "~/lib/run-scope";
import { PAUSE_KIND, RunScopes, workingDirectory } from "~/lib/run-scope";
import type { RunStore } from "~/lib/run-store";
import { MemoryRunStore, TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import type { ActivityStore } from "~/lib/sandbox/activities";
import { HarnessActivities } from "~/lib/sandbox/activities";
import type { DeferredApprovalStore } from "~/lib/sandbox/deferred-approvals";
import { StoredAgentGrantRepository } from "~/lib/sandbox/grants";
import { HarnessInteractions } from "~/lib/sandbox/interactions";
import { removeRunOutput } from "~/lib/state/output";
import type { StepInput } from "~/lib/step-work";
import type { TaskDefinition } from "~/lib/tasks";
import { factoryFor } from "~/lib/tree";
import type { TriggerStore } from "~/lib/trigger-store";
import { MemoryTriggerStore } from "~/lib/trigger-store";
import type { Schedule } from "~/lib/triggers";
import type { UsageRecords } from "~/lib/usage";
import { UsageLedger, withRecovered } from "~/lib/usage";
import type {
  ReconciledRun,
  RunRecorded,
  SessionListing,
} from "~/lib/usage-evidence";
import { listsSessions, UsageEvidence } from "~/lib/usage-evidence";
import type { UsageStore } from "~/lib/usage-store";
import { MemoryUsageStore } from "~/lib/usage-store";

export interface EngineOptions {
  readonly activityStore?: ActivityStore;
  readonly approvals?: DeferredApprovalStore;
  readonly artifactReads?: Pick<ArtifactSubstrate, "get" | "readFile">;
  readonly artifacts: ArtifactSubstrate;
  readonly askable?: boolean;
  readonly automationStore?: AutomationStore;
  readonly changeRetention?: number;
  readonly containerRows?: Pick<ContainerStore, "list">;
  readonly containers: Containers | (() => Promise<Containers>);
  readonly cwd?: string;
  readonly dry?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly executionStore?: ExecutionStore;
  readonly git?: GitOptions;
  readonly grants?: GrantDocumentStorage;
  readonly handlerTimeout?: number;
  readonly home?: string;
  readonly log?: (level: LogLevel, message: string, origin: LogOrigin) => void;
  readonly models: ModelManager;
  readonly print?: (line: string) => void;
  readonly providers?: ProviderConfiguration;
  readonly queues?: Readonly<Record<string, QueueSettings>>;
  readonly records?: WorkspaceRecords;
  readonly recoverQueued?: boolean;
  readonly recoveryLog?: RecoveryLog;
  readonly root: string;
  readonly runs?: RunStore;
  readonly sessions: SessionStore;
  readonly spawned?: string;
  readonly state?: string;

  readonly triggers?: TriggerStore;
  readonly usageStore?: UsageStore;
  readonly workspaceId: string;
  readonly workspaces?: Catalogue;
  readonly worktrees?: string;
}

function contextOf(
  options: EngineOptions,
  spawned: string | undefined,
  currentModels: () => ModelManager | undefined
): ExecutionContext {
  return {
    cwd: options.cwd ?? options.root,
    environment: options.environment ?? environmentSnapshot(),
    get models() {
      return currentModels();
    },
    ...(spawned === undefined ? {} : { spawned }),
    workspaceId: options.workspaceId,
  };
}

function sessionListing(
  sessions: SessionStore,
  usage: UsageStore
): { readonly stamps?: SessionListing } {
  if (listsSessions(sessions)) {
    return { stamps: () => sessions.stamps() };
  }
  const outlives = !(
    sessions instanceof InMemorySessionStore ||
    usage instanceof MemoryUsageStore
  );
  return outlives ? { stamps: "unavailable" } : {};
}

function storesOf(options: EngineOptions): {
  readonly automations: AutomationStore;
  readonly executions: ExecutionStore;
  readonly runs: RunStore;
  readonly triggers: TriggerStore;
  readonly usage: UsageStore;
} {
  return {
    automations: options.automationStore ?? new MemoryAutomationStore(),
    executions: options.executionStore ?? new MemoryExecutionStore(),
    runs: options.runs ?? new MemoryRunStore(),
    triggers: options.triggers ?? new MemoryTriggerStore(),
    usage: options.usageStore ?? new MemoryUsageStore(),
  };
}

function recordedIn(
  scopes: ReadonlyRunScopes,
  runs: RunStore
): (runId: string) => Promise<RunRecorded> {
  return async (runId) => {
    const scope = scopes.get(runId);
    if (scope) {
      return { ledger: scope.ledger.toJSON(), session: scope.session.id };
    }
    try {
      return await runs.recorded(runId);
    } catch {
      return "unreadable";
    }
  };
}

const RETIRED_POLL_MS = 250;
const RELEASE_RETRY_MS = 1000;
const RELEASE_RETRY_MAX_MS = 30_000;

interface OwedRelease {
  readonly released?: () => void;
  said: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface Running {
  readonly held: HeldRuns;
  readonly listing: RunListing;
  readonly orchestrator: Orchestrator;
  readonly router: FeedRouter;
  readonly store: ExecutionCoordinator;
}

const ORCHESTRATOR_CONCURRENCY = Number.MAX_SAFE_INTEGER;

// biome-ignore lint/performance/noBarrelFile: Preserve the existing engine error export after moving run tracking.
export { RunEndedError } from "~/lib/held-runs";

export class Engine {
  readonly activities: HarnessActivities;
  readonly agents: AgentsManager;
  readonly artifacts: ArtifactsManager;
  readonly automations: AutomationService;
  readonly bindings: Bindings;
  readonly context: ExecutionContext;
  readonly executions: ExecutionRuns;
  readonly feed: FeedReader;
  readonly interactions: HarnessInteractions;
  readonly models: ModelManager;
  readonly airplane: AirplaneMode;
  readonly providers: ProviderConfiguration | undefined;
  readonly root: string;
  readonly sandboxes: SandboxesManager;
  readonly scopes: ReadonlyRunScopes;
  readonly sessions: SessionStore;
  readonly state: string | undefined;
  readonly triggers: TriggerStore;
  readonly usage: UsageLedger;
  readonly taskStore: TaskStore;
  readonly workspaceId: string;
  readonly workspaces: WorkspacesManager;
  readonly worktrees: string;

  readonly #askable: boolean;
  readonly #evidence: UsageEvidence;
  readonly #publisher: FeedPublisher;
  readonly #print: (line: string) => void;
  readonly #registry = new Registry();
  readonly #scopes = new RunScopes();
  readonly #extra = new Map<string, (orchestrator: Orchestrator) => void>();
  readonly #executions: Executions;
  readonly #crashRecovery: CrashRecovery;
  readonly #recoveryLog: RecoveryLog | undefined;
  #lastRecovery: RecoveryReport | undefined;
  readonly #launcher: Launcher;
  readonly #records: WorkspaceRecords;
  readonly #runs: RunStore;
  readonly #usageStore: UsageStore;
  readonly #automationStore: AutomationStore;
  readonly #executionStore: ExecutionStore;
  readonly #delivery: Delivery;
  readonly #directNames = new WeakMap<AnyDefinition, string>();
  #running: Running | undefined;
  #phase: "new" | "starting" | "started" | "failed" | "stopping" = "new";
  #starting: Promise<this> | undefined;
  #stopping: Promise<void> | undefined;
  #cancelStopping: (() => Promise<void>) | undefined;
  #retiring = false;
  readonly #letGo = new Set<string>();
  readonly #owed = new Map<string, OwedRelease>();
  #released = false;
  #disposing: Promise<void> | undefined;
  readonly #unwatch: () => void;
  readonly #unwatchRecords: () => void;
  #prices: ModelsDevHold | undefined;

  static worktreesFor(state: string | undefined): string {
    return join(state ?? join(tmpdir(), "marbles"), "worktrees");
  }

  static persistence(
    options: Pick<EngineOptions, "dry" | "spawned" | "state">
  ): { readonly spawned?: string; readonly state?: string } {
    if (options.dry === true) {
      return {};
    }
    const { spawned, state } = options;
    return {
      ...(spawned === undefined ? {} : { spawned }),
      ...(state === undefined ? {} : { state }),
    };
  }

  constructor(options: EngineOptions) {
    const { models, root, sessions, workspaceId } = options;
    const { spawned, state } = Engine.persistence(options);
    const print = options.print ?? (() => undefined);
    const home = options.home ?? homedir();
    const askable = options.askable ?? false;
    const { containers } = options;
    this.models = models;
    this.#prices = holdModelsDev();
    const airplane = airplaneMode(models);
    this.airplane = {
      dispose: () => airplane.dispose(),
      get enabled() {
        return airplane.enabled;
      },
      set: (enabled) => {
        airplane.set(enabled);
        this.providers?.setOffline(enabled);
        if (enabled) {
          this.#releasePrices();
        } else if (!this.#disposing) {
          this.#prices ??= holdModelsDev();
          this.#listModels();
        }
      },
    };
    this.providers = options.providers;
    this.#unwatch =
      options.providers?.watch((problem) => print(`[providers] ${problem}`)) ??
      (() => undefined);
    this.root = root;
    this.scopes = this.#scopes;
    this.sessions = sessions;
    this.state = state;
    const { automations, executions, runs, triggers, usage } =
      storesOf(options);
    this.#automationStore = automations;
    this.#executionStore = executions;
    this.triggers = triggers;
    this.#usageStore = usage;
    this.usage = new UsageLedger(usage);
    this.#runs = runs;
    this.#evidence = new UsageEvidence({
      recordedOf: recordedIn(this.#scopes, runs),
      sessions,
      ...sessionListing(sessions, usage),
    });
    this.workspaceId = workspaceId;
    this.context = contextOf(options, spawned, () =>
      this.disposed ? undefined : models
    );
    this.worktrees = options.worktrees ?? Engine.worktreesFor(state);
    this.#executions = new Executions({
      ...(options.queues === undefined ? {} : { queues: options.queues }),
      removed: (run) => this.#removeRun(run),
      runs,
      store: executions,
      warn: print,
    });
    this.executions = this.#executions;
    this.#launcher = new Launcher({
      agents: (run) => this.agents.forRun(run),
      context: this.context,
      executions: this.#executions,
      print,
      recoverQueued: options.recoverQueued ?? false,
      sandbox: (container, signal) => this.sandboxes.adopt(container, signal),
      workflows: {
        cancel: async (id) => {
          await this.#live().orchestrator.cancelRun(id);
        },
        dispatch: (run, input, signal) => this.#dispatch(run, input, signal),
        has: (name) => this.#registered(name),
      },
    });
    this.#records = options.records ?? new MemoryWorkspaceRecords();
    this.#delivery = new Delivery({
      context: this.context,
      handlerTimeout: options.handlerTimeout,
      print,
      records: this.#records,
      retention: options.changeRetention,
    });
    this.#unwatchRecords = this.#records.watch(() => this.#delivery.wake());
    this.taskStore = this.#records.taskStore;
    const catalogue = options.workspaces ?? localCatalogue(options.git ?? {});
    this.#askable = askable;
    this.#print = print;
    this.#publisher = feedPublisher(options.artifacts, {
      id: workspaceId,
      name: basename(root),
      root,
    });
    this.feed = feedReader(options.artifacts);
    this.activities = new HarnessActivities({
      feed: this.#publisher,
      ...(options.activityStore ? { store: options.activityStore } : {}),
    });
    this.#recoveryLog = options.recoveryLog;
    this.#crashRecovery = this.#recoveryOf(options, print, runs);
    this.automations = new AutomationService({
      allowHttp: configuredMonitorUrl(this.#registry),
      registry: this.#registry,
      store: automations,
    });
    this.interactions = new HarnessInteractions({
      askable,
      feed: this.#publisher,
      policy: options.grants
        ? createAgentAuthorizer({
            grants: new StoredAgentGrantRepository(options.grants),
          })
        : createInMemoryAgentAuthorizer().authorizer,
      sessions,
      ...(options.approvals ? { approvals: options.approvals } : {}),
    });
    const sandboxes = new SandboxesManager({
      containers:
        typeof containers === "function"
          ? containers
          : () => Promise.resolve(containers),
      root,
    });
    this.sandboxes = sandboxes;
    this.agents = new AgentsManager({
      activities: this.activities,
      automations: this.automations,
      containerOf: (sandbox) => sandboxes.containerOf(sandbox),
      context: this.context,
      defaultExecutor: () => selectExecutor(models),
      dry: options.dry ?? false,
      executionOf: (provider) => options.providers?.executionOf(provider),
      ...(options.providers
        ? {
            instanceOf: (provider: string) =>
              options.providers?.identityOf(provider),
          }
        : {}),
      cwd: this.context.cwd,
      implementationOf: (provider) =>
        options.providers
          ?.list()
          .find(
            (entry) => entry.id === provider && entry.position !== undefined
          )?.plugin,
      interactions: this.interactions,
      models,
      observe: (runId, observation) =>
        this.#executions.observe(runId, observation),
      requireProviders: () => options.providers?.require(),
      sessions,
      skills: skillResolver({ home, workspace: root }),
      usage: { ledger: this.usage, workspaceId },
      warn: (message) => print(`[agents] ${message}`),
    });
    this.artifacts = new ArtifactsManager({
      artifacts: options.artifacts,
      ...(options.artifactReads ? { readThrough: options.artifactReads } : {}),
      workspaceId,
    });
    this.workspaces = new WorkspacesManager({
      catalogue,
      context: this.context,
      gitOptions: options.git ?? {},
      root,
      worktreeHome: this.worktrees,
    });
    this.bindings = {
      agents: (args) => this.agents.scoped(args),
      artifacts: (args) => this.artifacts.scoped(args),
      context: this.context,
      exec: ({ frame, scope, write }) =>
        commandRunner({
          cwd: () => workingDirectory(scope.cwd),
          dry: options.dry ?? false,
          environment: this.context.environment,
          print,
          ...(this.context.spawned === undefined
            ? {}
            : { spawned: this.context.spawned }),
          signal: () => frame.signal,
          work: frame.work,
          write,
        }),
      host: { catalogue, triggers: this.triggers },
      log: createLog((level, message) =>
        options.log
          ? options.log(level, message, { kind: "step" })
          : print(message)
      ),
      root,
      sandboxes: (args) => this.sandboxes.scoped(args),
      setupLog: (run) =>
        createLog((level, message) =>
          options.log
            ? options.log(level, message, {
                kind: "setup",
                runId: run.id,
                workflow: run.workflow,
              })
            : print(message)
        ),
      turns: (args) => this.agents.turns(args),
      workspaces: (args) => this.workspaces.scoped(args),
    };
  }

  async #removeRun(run: ExecutionRun): Promise<void> {
    if (run.kind !== "workflow") {
      return;
    }
    if (this.state !== undefined) {
      removeRunOutput(this.state, run.id);
    }
    await this.#runs.remove(run.id);
    this.#running?.listing.remove(run.id);
  }

  get harnesses(): readonly string[] {
    return [
      ...new Set(
        this.models.providers
          .filter((provider) => provider.available)
          .map((provider) => harnessOf(provider.id))
      ),
    ];
  }

  define(definition: AnyDefinition): void {
    if (definition.name !== undefined) {
      this.#claim(definition.name, { definitions: false, label: "define" });
    }
    this.#registry.define(definition);
    if (definition.name !== undefined) {
      this.#adopt(definition.name);
    }
  }

  #adopt(name: string): void {
    const definition = this.#registry.definitions.get(name);
    if (definition && this.#running) {
      this.#running.orchestrator.register(
        name,
        factoryFor(definition, () => this.bindings, this.#scopes)
      );
    }
  }

  has(name: string): boolean {
    return this.#registry.definitions.has(name);
  }

  definitions(): readonly DefinitionEntry[] {
    return this.#registry.entries();
  }

  schedule(record: Schedule): void {
    this.#registry.schedule(record);
  }

  monitor(record: MonitorRecord): void {
    this.#claim(record.key, { definitions: false, label: "monitor" });
    this.#registry.monitor(record);
    this.#adopt(record.key);
  }

  observe<T extends Fact>(
    source: Source<T>,
    handler: Handler<T>,
    options: Partial<ObserveOptions> = {}
  ): void {
    const name = options.name ?? handler.name;
    if (name === "") {
      throw new TypeError(
        "observe: give the observer a name (`{ name }`), or a named handler"
      );
    }
    this.#delivery.observe(source, handler, { ...options, name });
  }

  monitors(): ReadonlyMap<string, MonitorRecord> {
    return this.#registry.monitors;
  }

  register<I, O, X extends BaseContext = BaseContext>(
    name: string,
    factory: Factory<I, O, X>
  ): void {
    if (this.#phase !== "new") {
      throw new Error(`register("${name}"): the engine has already started`);
    }
    this.#claim(name, { definitions: true, label: "register" });
    this.#extra.set(name, (orchestrator) =>
      orchestrator.register(name, factory)
    );
  }

  task<I, O>(definition: TaskDefinition<I, O>): void {
    this.#claim(definition.name, { definitions: true, label: "task" });
    this.#launcher.task(definition as TaskDefinition);
  }

  #claim(
    name: string,
    claim: { readonly definitions: boolean; readonly label: string }
  ): void {
    if (
      this.#launcher.has(name) ||
      this.#extra.has(name) ||
      (claim.definitions && this.#registry.definitions.has(name))
    ) {
      throw new Error(`${claim.label}("${name}"): already registered`);
    }
  }

  #registered(name: string): boolean {
    return this.#registry.definitions.has(name) || this.#extra.has(name);
  }

  #registerAll(orchestrator: Orchestrator): void {
    for (const [name, definition] of this.#registry.definitions) {
      orchestrator.register(
        name,
        factoryFor(definition, () => this.bindings, this.#scopes)
      );
    }
    for (const register of this.#extra.values()) {
      register(orchestrator);
    }
  }

  #recoveryOf(
    options: EngineOptions,
    print: (line: string) => void,
    runs: RunStore
  ): CrashRecovery {
    const { containerRows } = options;
    const { spawned } = Engine.persistence(options);
    return new CrashRecovery({
      activities: this.activities,
      artifacts: options.artifacts,
      ...(containerRows === undefined ? {} : { containerRows }),
      containers: () => this.sandboxes.containers(),
      executions: () => this.#executions.list(),
      print,
      runs,
      ...(spawned === undefined ? {} : { spawned }),
    });
  }

  start(): Promise<this> {
    if (this.#disposing) {
      return Promise.reject(new Error("the engine was disposed"));
    }
    if (this.#phase !== "new") {
      return Promise.reject(new Error("the engine has already started"));
    }
    this.#phase = "starting";
    this.#starting = this.#start();
    return this.#starting;
  }

  async #start(): Promise<this> {
    const { state } = this;
    const askable = this.#askable;
    const feed = this.#publisher;
    const print = this.#print;
    await this.#listModels();
    const config = new Config();
    contributeQueueConfig(config, {
      concurrency: ORCHESTRATOR_CONCURRENCY,
      defaultName: DEFAULT_QUEUE,
    });
    let orchestrator: Orchestrator | undefined;
    let adopted: ReadonlyMap<string, RecordedScope> = new Map();
    try {
      await this.activities.load();
      await this.#executions.load();
      const store = new ExecutionCoordinator({
        store: await this.#runs.open(
          (runId) => this.#scopes.get(runId)?.recorded(),
          (runId, status) => this.#executions.follows(runId, status)
        ),
      });
      adopted = await adoptParkedRuns({
        askable,
        print,
        registered: (name) => this.#registered(name),
        runs: this.#runs,
        settled: (runId) => this.#executions.storedSettled(runId),
        store,
      });
      for (const [runId, scope] of adopted) {
        this.#scopes.recover(runId, scope);
      }
      const statuses = await workflowStatuses(store, this.#executions.list());

      orchestrator = new Orchestrator({
        config,
        recovers: (run) =>
          adopted.has(run.id) && run.lastStatus === "suspended",
        store,
      });
      await orchestrator.setup();
      this.#registerAll(orchestrator);
      await orchestrator.start();
      const router = feedRouter({ askable, feed, orchestrator, print });
      const held = new HeldRuns({
        executions: this.#executions,
        orchestrator,
        print,
        router,
        scopes: this.#scopes,
        state,
      });
      const recovered: {
        createdAt: number;
        name: string;
        dispatched: Dispatched<unknown>;
      }[] = [];

      for (const runId of adopted.keys()) {
        const dispatched = await orchestrator.get(runId);
        const record = await store.getRun(runId);
        if (!(dispatched && record)) {
          this.#scopes.forget(runId);
          await this.#runs.release(runId);
          continue;
        }
        print(`[run] ${record.step} recovered ${runId}`);
        recovered.push({
          createdAt: record.timestamps.createdAt,
          dispatched,
          name: record.step,
        });
        await router.adopt(record.step, runId);
      }
      await this.interactions.restore();
      await feed
        .cancelAbandoned()
        .catch((error: unknown) => print(`[feed] ${String(error)}`));
      const listing = new RunListing(store);
      await listing.load();
      for (const { dispatched } of recovered) {
        listing.add(dispatched.id);
      }
      this.#running = { held, listing, orchestrator, router, store };
      for (const { createdAt, name, dispatched } of recovered) {
        await this.#executions
          .adoptParked({ createdAt, id: dispatched.id, name })
          .catch((error: unknown) =>
            print(
              `[state] run ${dispatched.id} has no record: ${String(error)}`
            )
          );
        this.#launcher.follow(dispatched.id, held.follow(name, dispatched));
      }
      await this.#delivery.start();
      this.#phase = "started";
      await this.#recover(
        new Set(recovered.map(({ dispatched }) => dispatched.id)),
        statuses
      );
      const recovery = await this.#crashRecovery.recover(store);
      for (const runId of recovery.closed) {
        listing.add(runId);
      }
      this.#lastRecovery = recovery.report;
      await this.#recoveryLog
        ?.record(recovery.report)
        .catch((error: unknown) =>
          print(`[recovery] its report was not kept: ${String(error)}`)
        );
      this.#delivery.wake();
    } catch (error) {
      this.#phase = "failed";
      try {
        try {
          await this.#delivery.stop();
          await this.#launcher.halt(true);
          await orchestrator?.stop();
          await this.#launcher.settled();
        } finally {
          for (const scope of this.#scopes) {
            scope.abort(error);
            await this.#scopes.settle(scope.id);
          }
        }
      } finally {
        for (const runId of adopted.keys()) {
          this.#scopes.forget(runId);
        }
        this.#running = undefined;
        await this.#runs.release().catch(() => undefined);
      }
      throw error;
    }
    return this;
  }

  #recover(
    adopted: ReadonlySet<string>,
    statuses: ReadonlyMap<string, string>
  ): Promise<void> {
    return this.#launcher.recover({
      adopted,
      fileStatus: (run) =>
        run.kind === "workflow" ? statuses.get(run.id) : undefined,
    });
  }

  async #dispatch(
    run: ExecutionRun,
    input: unknown,
    signal: AbortSignal
  ): Promise<DispatchedRun> {
    const { orchestrator } = this.#live();
    const { correlation } = run;
    let dispatched: Dispatched<unknown>;
    try {
      dispatched = await orchestrator.run<unknown, unknown>(run.name, input, {
        extensions:
          "triggerId" in correlation
            ? { triggerId: correlation.triggerId }
            : {},
        runId: run.id,
        signal,
      });
    } catch (error) {
      await this.#scopes.settle(run.id);
      throw error;
    }
    const { held, listing } = this.#live();
    listing.add(run.id);
    return held.follow(run.name, dispatched);
  }

  #live(): Running {
    if (!this.#running) {
      throw new Error("the engine has not started");
    }
    return this.#running;
  }

  #scopeOf(runId: string) {
    const scope = this.scopes.get(runId);
    if (!scope) {
      throw new Error(`run ${runId} is not running here`);
    }
    return scope;
  }

  async answer(entryId: string, answer: FeedAnswer): Promise<void> {
    if (await this.interactions.answer(entryId, answer)) {
      return;
    }
    return this.#live().router.answer(entryId, answer);
  }

  cancel(runId: string): Promise<void> {
    return this.#launcher.cancel(runId);
  }

  async launch<O>(
    name: string,
    input: unknown,
    options?: string | LaunchOptions
  ): Promise<Launched<O>> {
    this.#live();
    if (this.#phase !== "started") {
      throw new Error(
        this.#phase === "stopping"
          ? "engine is stopping"
          : "engine has not finished starting"
      );
    }
    return await this.#launcher.launch<O>(
      name,
      input,
      typeof options === "string" ? { triggerId: options } : (options ?? {})
    );
  }

  pause(runId: string, stepId: string, reason?: string): boolean {
    return this.scopes.get(runId)?.pause(stepId, reason) ?? false;
  }

  async resume(runId: string, stepId: string, prompt?: string): Promise<void> {
    const { orchestrator } = this.#live();
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `retire` sets it.
    if (this.#retiring || this.#letGo.has(runId)) {
      throw new QuestionMovingError(runId);
    }
    const scope = this.#scopeOf(runId);
    const pending = await orchestrator.listSuspensions({
      kind: PAUSE_KIND,
      runId,
      status: "pending",
    });
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `retire` sets it.
    if (this.#retiring || this.#letGo.has(runId)) {
      throw new QuestionMovingError(runId);
    }
    const below = stepId.split(".").slice(1).join(".");
    const under = (path: string, wanted: string) =>
      path === wanted || (wanted !== "" && path.startsWith(`${wanted}.`));
    const parked = pending.items.filter(
      (item) =>
        under(item.stepPath.join("."), stepId) ||
        under(item.stepPath.slice(1).join("."), below)
    );
    if (parked.length === 0) {
      throw new Error(`"${stepId}" is not paused`);
    }
    const trimmed = prompt?.trim() || undefined;
    for (const suspension of parked) {
      const frame = scope.frames.get(suspension.stepPath.join("."));
      if (frame && trimmed !== undefined) {
        frame.resumePrompt = trimmed;
      }
      await orchestrator
        .resolve(
          suspension.id,
          { prompt: trimmed ?? null },
          { expectedRevision: suspension.revision }
        )
        .catch((error: unknown) => {
          throw movedAway(error, runId);
        });
    }
  }

  async run<O>(
    name: string,
    input: unknown,
    options?: string | LaunchOptions
  ): Promise<O> {
    const launched = await this.launch<O>(name, input, options);
    return launched.result;
  }

  async execute<O>(definition: AnyDefinition, input: unknown): Promise<O> {
    if (this.disposed) {
      throw new Error("engine is stopping");
    }
    if (this.#phase === "new") {
      await this.start();
    } else if (this.#phase === "starting") {
      await this.#starting;
    }
    const { orchestrator } = this.#live();
    let name = this.#directNames.get(definition);
    if (name === undefined) {
      const declared = definition.name;
      const registered =
        declared !== undefined &&
        this.#registry.definitions.get(declared) === definition
          ? declared
          : undefined;
      name = registered ?? `direct-${crypto.randomUUID()}`;
      if (registered === undefined) {
        const directName = name;
        const register = (target: Orchestrator) =>
          target.register(
            directName,
            factoryFor(
              definition,
              () => this.bindings,
              this.#scopes,
              directName
            )
          );
        this.#extra.set(directName, register);
        register(orchestrator);
      }
      this.#directNames.set(definition, name);
    }
    const launched = await this.launch<O>(name, input);
    return launched.result;
  }

  async readUsage(): Promise<UsageRecords> {
    const runs = (await this.runs()).map((record): ReconciledRun => {
      const { timestamps } = record;
      const ended = timestamps.completedAt ?? timestamps.failedAt;
      const unwritten =
        TERMINAL_RUN_STATUSES.has(record.status) &&
        this.#live().held.workflow(record.id) !== undefined;
      return {
        active:
          record.status === "queued" ||
          record.status === "running" ||
          unwritten,
        createdAt: timestamps.createdAt,
        definition: record.step,
        ...(ended === null || ended === undefined ? {} : { endedAt: ended }),
        id: record.id,
        status: record.status,
      };
    });
    const found = await this.#evidence.unrecorded(
      await this.usage.read(),
      runs,
      this.workspaceId
    );
    return withRecovered(await this.usage.read(), found);
  }

  get lastRecovery(): RecoveryReport | undefined {
    return this.#lastRecovery;
  }

  async runs(): Promise<readonly RunRecord[]> {
    const { held, listing } = this.#live();
    return (await listing.list()).map((record) => {
      const current = held.workflow(record.id)?.state;
      return current
        ? {
            ...record,
            metadata: { ...record.metadata, workflow: current },
            snapshot: current.tree ?? record.snapshot,
          }
        : record;
    });
  }

  schedules(): Promise<readonly Schedule[]> {
    return this.automations.schedules();
  }

  steer(runId: string, stepId: string, prompt: string): void {
    this.#scopeOf(runId).steer(stepId, prompt);
  }

  send(runId: string, stepId: string, input: StepInput): void {
    this.#scopeOf(runId).send(stepId, input);
  }

  async retire(
    successor: ProcessIdentity,
    options: {
      readonly onHanded?: (runId: string) => void;
      readonly onLetGo?: (runId: string) => void;
    } = {}
  ): Promise<{ readonly ended: Promise<void> }> {
    const running = this.#running;
    if (running === undefined) {
      return { ended: Promise.resolve() };
    }
    this.#retiring = true;
    this.#launcher.beginRetiring();
    running.router.retire();
    await this.#delivery.stop({ grace: 0 }).catch((error: unknown) => {
      this.#print(
        `[engine] the delivery claim was not given up as this engine retires: ${String(error)}`
      );
    });
    const handedLate = (late: string) => options.onHanded?.(late);
    for (const runId of await this.#launcher.handOver(successor, handedLate)) {
      this.#letGo.add(runId);
    }
    running.orchestrator.on("suspended", ({ runId }) => {
      if (
        this.#letGo.has(runId) ||
        running.held.workflow(runId) === undefined
      ) {
        return;
      }
      this.#giveBack(running, runId, () => options.onLetGo?.(runId)).catch(
        (error: unknown) =>
          this.#print(
            `[run] ${runId} let go, and not reported: ${String(error)}`
          )
      );
    });
    for (const runId of running.held.withStatus(["suspended"])) {
      if (!this.#letGo.has(runId)) {
        await this.#giveBack(running, runId);
      }
    }
    const left = () =>
      this.#executions
        .list()
        .some(
          (run) =>
            !(
              this.#letGo.has(run.id) ||
              SETTLED_EXECUTION_STATUSES.has(run.status)
            ) && sameProcess(run.owner, thisProcess())
        );
    const runsEnded = new Promise<void>((resolve) => {
      const look = () => {
        if (left()) {
          setTimeout(look, RETIRED_POLL_MS).unref?.();
        } else {
          resolve();
        }
      };
      look();
    });
    return { ended: runsEnded };
  }

  async takeQueued(runId: string, owner: ProcessIdentity): Promise<QueuedTake> {
    if (this.#running === undefined || this.#phase !== "started") {
      return { taken: false, why: "this engine is not running" };
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `retire` sets it.
    if (this.#retiring) {
      return { taken: false, why: "this engine is retiring" };
    }
    return await this.#launcher.takeOrphaned(runId, owner);
  }

  async adopt(runId: string): Promise<boolean> {
    const running = this.#running;
    const away = () =>
      this.#running !== running || this.#phase !== "started" || this.#retiring;
    if (running === undefined || away()) {
      return false;
    }
    const handed = await this.#launcher.takeHanded(runId);
    if (handed !== undefined) {
      return handed;
    }
    const record = await running.store.getRun(runId);
    if (record?.status !== "suspended" || away()) {
      return false;
    }
    const owed = this.#forgive(runId);
    let scope: Awaited<ReturnType<typeof adoptParkedRun>>;
    try {
      scope = await adoptParkedRun(record, {
        askable: this.#askable,
        print: () => undefined,
        registered: (name) => this.#registered(name),
        runs: this.#runs,
        settled: (id) => this.#executions.storedSettled(id),
        store: running.store,
      });
    } catch (error) {
      if (owed !== undefined) {
        await this.#giveBack(running, runId, owed.released);
      }
      throw error;
    }
    if (scope === undefined) {
      if (owed !== undefined) {
        await this.#giveBack(running, runId, owed.released);
      }
      return false;
    }
    this.#scopes.recover(runId, scope);
    this.#letGo.delete(runId);
    let dispatched: Awaited<ReturnType<Orchestrator["adopt"]>>;
    try {
      if (away()) {
        throw new Error("this engine began to retire");
      }
      if (!(await this.#executions.takeReleased(runId))) {
        throw new Error("its execution run is not parked");
      }
      if (away()) {
        throw new Error("this engine began to retire");
      }
      dispatched = await running.orchestrator.adopt(runId);
      if (dispatched === null) {
        throw new Error("it is no longer parked in the store");
      }
      if (away()) {
        throw new Error("this engine began to retire");
      }
      await running.router.adopt(record.step, runId);
      if (away()) {
        throw new Error("this engine began to retire");
      }
    } catch (error) {
      this.#scopes.forget(runId);
      await running.orchestrator
        .forget(runId)
        .catch((failure: unknown) =>
          this.#print(
            `[run] ${record.step} ${runId} not dropped from the queue: ${String(failure)}`
          )
        );
      await this.#giveBack(running, runId);
      if (away()) {
        this.#print(
          `[run] ${record.step} ${runId} given back: this engine began to retire as it took it over`
        );
        return false;
      }
      throw new Error(`run ${runId} was not taken over: ${String(error)}`, {
        cause: error,
      });
    }
    this.#print(`[run] ${record.step} taken over ${runId}`);
    running.listing.add(runId);
    this.#launcher.follow(runId, running.held.follow(record.step, dispatched));
    return true;
  }

  async #giveBack(
    running: Running,
    runId: string,
    released?: () => void
  ): Promise<void> {
    this.#letGo.add(runId);
    running.router.letGo(runId);
    const before = this.#forgive(runId);
    const tell = released ?? before?.released;
    const owed: OwedRelease = {
      ...(tell === undefined ? {} : { released: tell }),
      said: false,
    };
    this.#owed.set(runId, owed);
    await this.#release(runId, owed, RELEASE_RETRY_MS);
  }

  #forgive(runId: string): OwedRelease | undefined {
    const owed = this.#owed.get(runId);
    if (owed !== undefined) {
      clearTimeout(owed.timer);
      this.#owed.delete(runId);
    }
    return owed;
  }

  async #release(
    runId: string,
    owed: OwedRelease,
    delay: number
  ): Promise<void> {
    if (this.#owed.get(runId) !== owed) {
      return;
    }
    try {
      await this.#runs.release(runId);
    } catch (error) {
      if (this.#owed.get(runId) !== owed) {
        return;
      }
      if (this.#released) {
        this.#owed.delete(runId);
        return;
      }
      if (!owed.said) {
        owed.said = true;
        this.#print(
          `[run] ${runId} not let go: ${String(error)}; it stays claimed here, unanswered, and is tried again`
        );
      }
      owed.timer = setTimeout(() => {
        this.#release(
          runId,
          owed,
          Math.min(delay * 2, RELEASE_RETRY_MAX_MS)
        ).catch(() => undefined);
      }, delay);
      owed.timer.unref?.();
      return;
    }
    if (this.#owed.get(runId) === owed) {
      this.#owed.delete(runId);
      owed.released?.();
    }
  }

  stop(options?: { readonly cancel?: boolean }): Promise<void> {
    if (this.#phase === "starting") {
      return (
        this.#starting?.then(
          () => this.stop(options),
          () => undefined
        ) ?? Promise.resolve()
      );
    }
    if (!this.#running) {
      return Promise.resolve();
    }
    this.#phase = "stopping";
    const cancel = options?.cancel ?? false;
    const stopping = this.#stopping;
    if (stopping === undefined) {
      this.#stopping = this.#stop(this.#running, cancel);
      return this.#stopping;
    }
    if (!cancel || this.#cancelStopping === undefined) {
      return stopping;
    }
    return this.#cancelStopping().then(() => stopping);
  }

  async #stop(
    { held, orchestrator, router }: Running,
    cancel: boolean
  ): Promise<void> {
    let cancelling = cancel;
    let halted = false;
    let ended = false;
    const cancelHeld = async (): Promise<void> => {
      const doomed = this.#runs.durable
        ? ["queued", "running"]
        : ["queued", "running", "suspended"];
      await Promise.all(
        held.withStatus(doomed).map((runId) => orchestrator.cancelRun(runId))
      );
    };
    this.#cancelStopping = async () => {
      if (cancelling || ended) {
        return;
      }
      cancelling = true;
      this.#launcher.cancelPending();
      if (halted) {
        await cancelHeld();
      }
    };
    try {
      if (cancel) {
        this.#launcher.cancelPending();
      }
      await this.#delivery.stop();
      await this.interactions.close();
      if (!this.#runs.durable) {
        await router.cancelOpen();
      }
      await this.#launcher.halt(cancel);
      halted = true;
      if (cancelling) {
        await cancelHeld();
      }
      await this.#executions.drained();
      await orchestrator.drain();
      await this.#launcher.settled();
      await held.settle();
    } finally {
      ended = true;
      try {
        await orchestrator.stop();
        await this.#executions.flush();
        await this.#executions.retrySettlements();
      } finally {
        this.#released = true;
        for (const runId of [...this.#owed.keys()]) {
          this.#forgive(runId);
        }
        await this.#runs.release();
      }
    }
  }

  stream(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined {
    return this.#running?.held.workflow(runId)?.root.subscribe(signal);
  }

  async #listModels(): Promise<void> {
    try {
      if (this.providers === undefined) {
        return;
      }
      for (const problem of await this.providers.refresh()) {
        this.#print(`[providers] ${problem}`);
      }
    } catch (error) {
      this.#print(
        `[providers] ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  #releasePrices(): void {
    this.#prices?.release();
    this.#prices = undefined;
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose();
    return this.#disposing;
  }

  get disposed(): boolean {
    return this.#disposing !== undefined;
  }

  async #dispose(): Promise<void> {
    const errors: unknown[] = [];
    const close = async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    await this.#starting?.catch(() => undefined);
    await close(() => this.stop({ cancel: true }));
    await close(() => this.#delivery.stop());
    for (const scope of this.#scopes) {
      await close(() => this.#scopes.settle(scope.id));
    }
    this.#unwatchRecords();
    await close(() => this.#records.close());
    await close(() => this.#runs.close());
    await close(() => this.triggers.close());
    await close(() => this.#automationStore.close());
    await close(() => this.#executions.flush());
    await close(() => this.#executions.retrySettlements());
    this.#executions.stopRetrying();
    await close(() => this.#executionStore.close());
    await close(() => this.interactions.close());
    await close(() => this.workspaces.close());
    await close(() => this.sandboxes.close());
    this.#unwatch();
    this.airplane.dispose();
    this.#releasePrices();
    await close(async () => {
      await this.providers?.dispose();
    });
    await close(() => this.agents.close());
    await close(() => this.#usageStore.close());
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose the engine");
    }
  }
}
