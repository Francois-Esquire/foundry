import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SessionStore } from "@foundry/agents/store";
import type { Artifacts as ArtifactSubstrate } from "@foundry/artifacts";
import type { GrantDocumentStorage } from "@foundry/lib/config/authorization/document";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type { Models } from "@foundry/models";
import type { AirplaneMode } from "@foundry/models/airplane";
import { airplaneMode } from "@foundry/models/airplane";
import type { ModelsDevHold } from "@foundry/models/catalog/models-dev-source";
import { holdModelsDev } from "@foundry/models/catalog/models-dev-source";
import type { Containers } from "@foundry/sandbox/container/containers";
import type { ContainerStore } from "@foundry/sandbox/store";
import type { TaskStore } from "@foundry/tasks";
import type { ChannelMessage } from "@foundry/workflows/channels";
import type { BaseContext } from "@foundry/workflows/executable";
import { configuredMonitorUrl } from "~/lib/automation/configured";
import { AutomationService } from "~/lib/automation/service";
import type { AutomationStore } from "~/lib/automation/store";
import type { Bindings } from "~/lib/bindings";
import { harnessOf } from "~/lib/cli-harnesses";
import {
  CrashRecovery,
  type RecoveryLog,
  type RecoveryReport,
} from "~/lib/crash-recovery";
import type { AnyDefinition, NamedDefinition } from "~/lib/definition";
import { EngineDefinitions } from "~/lib/engine-definitions";
import {
  agentsOf,
  bindingsOf,
  contextOf,
  interactionsOf,
  recordedIn,
  sessionListing,
  storedScopes,
  storesOf,
} from "~/lib/engine-setup";
import type { ObserveOptions } from "~/lib/events/delivery";
import { Delivery } from "~/lib/events/delivery";
import type { WorkspaceRecords } from "~/lib/events/records";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import type { Fact, Handler, Source } from "~/lib/events/source";
import type { ExecutionContext } from "~/lib/execution-context";
import type { ExecutionStore } from "~/lib/execution-store";
import type { ExecutionRun, ExecutionRuns, PoolConfig } from "~/lib/executions";
import { Executions } from "~/lib/executions";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { FeedPublisher } from "~/lib/feed/publish";
import { feedPublisher } from "~/lib/feed/publish";
import type { FeedReader } from "~/lib/feed/read";
import { feedReader } from "~/lib/feed/read";
import type {
  DefinitionLaunch,
  Launched,
  LaunchOptions,
  QueuedAdoption,
} from "~/lib/launcher";
import { idempotencyKeyOf, Launcher } from "~/lib/launcher";
import type { LogLevel, LogOrigin } from "~/lib/log";
import type { AgentsManager } from "~/lib/managers/agents";
import { ArtifactsManager } from "~/lib/managers/artifacts";
import type { RunQuery, RunsSource, RunView } from "~/lib/managers/runs";
import { engineRuns } from "~/lib/managers/runs";
import { SandboxesManager } from "~/lib/managers/sandboxes";
import type { GitOptions, LocalWorkspaces } from "~/lib/managers/workspaces";
import { localWorkspaces, WorkspacesManager } from "~/lib/managers/workspaces";
import type { ProviderConfiguration } from "~/lib/providers/configuration";
import { QueuedWorkflows } from "~/lib/queued-workflows";
import type { DefinitionEntry, MonitorRecord } from "~/lib/registry";
import type { Factory } from "~/lib/run-queue";
import type { ReadonlyRunScopes } from "~/lib/run-scope";
import { RunScopes } from "~/lib/run-scope";
import type { RunStore } from "~/lib/run-store";
import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import type { ActivityStore } from "~/lib/sandbox/activities";
import { HarnessActivities } from "~/lib/sandbox/activities";
import type { DeferredApprovalStore } from "~/lib/sandbox/deferred-approvals";
import type { HarnessInteractions } from "~/lib/sandbox/interactions";
import { removeRunOutput } from "~/lib/state/output";
import type { StepInput } from "~/lib/step-work";
import type { TaskDefinition } from "~/lib/tasks";
import type { TriggerStore } from "~/lib/trigger-store";
import type { Schedule } from "~/lib/triggers";
import type { UsageRecords } from "~/lib/usage";
import { UsageLedger, withRecovered } from "~/lib/usage";
import type { ReconciledRun } from "~/lib/usage-evidence";
import { UsageEvidence } from "~/lib/usage-evidence";
import type { UsageStore } from "~/lib/usage-store";
import type { RunRecord } from "~/lib/workflow-runs";

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
  readonly models: Models;
  readonly pools?: Readonly<Record<string, PoolConfig>>;
  readonly print?: (line: string) => void;
  readonly providers?: ProviderConfiguration;
  readonly records?: WorkspaceRecords;
  readonly recoveryLog?: RecoveryLog;
  readonly root: string;
  readonly runs?: RunStore;
  readonly sessions: SessionStore;
  readonly spawned?: string;
  readonly state?: string;

  readonly triggers?: TriggerStore;
  readonly usageStore?: UsageStore;
  readonly workspaceId: string;
  readonly workspaces?: LocalWorkspaces;
  readonly worktrees?: string;
}

// biome-ignore lint/performance/noBarrelFile: Preserve the existing engine error export after moving run tracking.
export { RunEndedError } from "~/lib/followed-runs";

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
  readonly models: Models;
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
  readonly #feedEntries: Pick<ArtifactSubstrate, "get">;
  readonly #print: (line: string) => void;
  readonly #definitions: EngineDefinitions;
  readonly #scopes: RunScopes;
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
  readonly #runsSource: RunsSource = {
    enqueue: (definition, input, options) =>
      this.enqueueDefinition(definition, input, options),
    execution: (runId) => this.executions.get(runId),
    executions: () => this.executions.list(),
    named: (name) => this.definition(name),
    nameOf: (name) => this.#definitions.nameOf(name),
    resultOf: (runId) => this.#resultOf(runId),
    stored: async (runId) => await this.#running?.record(runId),
    storedAll: () =>
      this.#running === undefined ? Promise.resolve([]) : this.runs(),
  };
  #running: QueuedWorkflows | undefined;
  #phase: "new" | "starting" | "started" | "failed" | "stopping" = "new";
  #starting: Promise<this> | undefined;
  #stopping: Promise<void> | undefined;
  #cancelStopping: (() => Promise<void>) | undefined;
  #retiring = false;
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
    const { automations, executions, runs, triggers, usage } =
      storesOf(options);
    this.#scopes = new RunScopes(storedScopes(runs));
    this.scopes = this.#scopes;
    this.#definitions = new EngineDefinitions({
      bindings: () => this.bindings,
      launcher: () => this.#launcher,
      running: () => this.#running,
      scopes: this.#scopes,
    });
    this.sessions = sessions;
    this.state = state;
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
      ...(options.pools === undefined ? {} : { pools: options.pools }),
      removed: (run) => this.#removeRun(run),
      store: executions,
      warn: print,
    });
    this.executions = this.#executions;
    this.#launcher = new Launcher({
      agents: (run) => this.agents.forRun(run),
      context: this.context,
      executions: this.#executions,
      print,
      sandbox: (container, signal) => this.sandboxes.adopt(container, signal),
      workflows: {
        cancel: (id, reason) => this.#live().cancel(id, reason),
        dispatch: (name, input, submit) =>
          this.#live().dispatch(name, input, submit),
        has: (name) => this.#definitions.registered(name),
        poolOf: (name) => this.#definitions.poolOf(name),
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
    const catalogue = options.workspaces ?? localWorkspaces(options.git ?? {});
    this.#askable = askable;
    this.#print = print;
    this.#publisher = feedPublisher(options.artifacts, {
      id: workspaceId,
      name: basename(root),
      root,
    });
    this.feed = feedReader(options.artifacts);
    this.#feedEntries = options.artifacts;
    this.activities = new HarnessActivities({
      feed: this.#publisher,
      ...(options.activityStore ? { store: options.activityStore } : {}),
    });
    this.#recoveryLog = options.recoveryLog;
    this.#crashRecovery = this.#recoveryOf(options, print);
    this.automations = new AutomationService({
      allowHttp: configuredMonitorUrl(this.#definitions.registry),
      registry: this.#definitions.registry,
      store: automations,
    });
    this.interactions = interactionsOf(options, this.#publisher);
    const sandboxes = new SandboxesManager({
      containers:
        typeof containers === "function"
          ? containers
          : () => Promise.resolve(containers),
      root,
    });
    this.sandboxes = sandboxes;
    this.agents = agentsOf(options, {
      activities: this.activities,
      automations: this.automations,
      context: this.context,
      executions: this.#executions,
      interactions: this.interactions,
      sandboxes,
      usage: this.usage,
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
    this.bindings = bindingsOf(options, {
      agents: this.agents,
      artifacts: this.artifacts,
      catalogue,
      context: this.context,
      print,
      runs: this.#runsSource,
      sandboxes: this.sandboxes,
      triggers: this.triggers,
      workspaces: this.workspaces,
    });
  }

  #removeRun(run: ExecutionRun): void {
    if (run.kind !== "workflow") {
      return;
    }
    if (this.state !== undefined) {
      removeRunOutput(this.state, run.id);
    }
    this.#running?.unlisted(run.id);
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

  define(definition: AnyDefinition, pool?: string): void {
    this.#definitions.define(definition, pool);
  }

  has(name: string): boolean {
    return this.#definitions.registry.definitions.has(name);
  }

  definition(name: string): NamedDefinition | undefined {
    return this.#definitions.registry.launchable(name);
  }

  definitions(): readonly DefinitionEntry[] {
    return this.#definitions.registry.entries();
  }

  schedule(record: Schedule): void {
    this.#definitions.registry.schedule(record);
  }

  monitor(record: MonitorRecord): void {
    this.#definitions.monitor(record);
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
    return this.#definitions.registry.monitors;
  }

  register<I, O, X extends BaseContext = BaseContext>(
    name: string,
    factory: Factory<I, O, X>
  ): void {
    if (this.#phase !== "new") {
      throw new Error(`register("${name}"): the engine has already started`);
    }
    this.#definitions.register(name, factory);
  }

  task<I, O>(definition: TaskDefinition<I, O>): void {
    this.#definitions.task(definition);
  }

  #recoveryOf(
    options: EngineOptions,
    print: (line: string) => void
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
    let running: QueuedWorkflows | undefined;
    try {
      await this.activities.load();
      const store = await this.#runs.open((runId) =>
        this.#scopes.get(runId)?.recorded()
      );
      running = await QueuedWorkflows.open({
        askable,
        durable: this.#runs.durable,
        executions: this.#executions,
        feed,
        feedEntries: this.#feedEntries,
        follow: (runId, dispatched) => this.#launcher.follow(runId, dispatched),
        pools: this.#executions.initialPools(),
        print,
        registered: (name) => this.#definitions.registered(name),
        scopes: this.#scopes,
        state,
        store,
      });
      await this.interactions.restore();
      await feed
        .cancelAbandoned()
        .catch((error: unknown) => print(`[feed] ${String(error)}`));
      await running.queue.pause();
      this.#executions.attach(running.queue);
      await this.#executions.load();
      this.#running = running;
      await this.#launcher.attach(running.queue);
      this.#definitions.registerAll(running);
      await this.#delivery.start();
      this.#phase = "started";
      const recovery = await this.#crashRecovery.recover(
        async () => (await this.#launcher.recover()).interrupted
      );
      for (const runId of recovery.closed) {
        running.listed(runId);
      }
      await running.queue.resume();
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
        await this.#delivery.stop();
        this.#executions.detach();
        await running?.stop();
      } finally {
        this.#running = undefined;
        for (const scope of this.#scopes) {
          scope.abort(error);
          await this.#scopes.settle(scope.id);
        }
      }
      throw error;
    }
    return this;
  }

  #live(): QueuedWorkflows {
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
    return this.#live().answer(entryId, answer);
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

  resume(runId: string, stepId: string, prompt?: string): Promise<void> {
    return this.#live().resume(runId, stepId, prompt);
  }

  async run<O>(
    name: string,
    input: unknown,
    options?: string | LaunchOptions
  ): Promise<O> {
    const launched = await this.launch<O>(name, input, options);
    return launched.result;
  }

  async enqueueDefinition<O>(
    definition: AnyDefinition,
    input: unknown,
    options: DefinitionLaunch = {}
  ): Promise<Launched<O>> {
    const { key } = options;
    if (key !== undefined && (typeof key !== "string" || key.trim() === "")) {
      throw new TypeError("enqueue(): a key must be a non-blank string");
    }
    if (this.disposed) {
      throw new Error("engine is stopping");
    }
    if (this.#phase === "new") {
      await this.start();
    } else if (this.#phase === "starting") {
      await this.#starting;
    }
    const declared = this.#definitions.declaredName(definition);
    if (key !== undefined && declared === undefined) {
      throw new Error(
        `enqueue(): a key is matched by the definition's name, and ${definition.name === undefined ? "this definition has none" : `"${definition.name}" is not a definition this workspace declares`}; declare it by name in the workspace's source to enqueue it with a key`
      );
    }
    const name =
      declared ?? this.#definitions.directName(definition, this.#live());
    return await this.launch<O>(
      name,
      input,
      key === undefined ? {} : { idempotencyKey: idempotencyKeyOf(name, key) }
    );
  }

  async execute<O>(definition: AnyDefinition, input: unknown): Promise<O> {
    const launched = await this.enqueueDefinition<O>(definition, input);
    return launched.result;
  }

  readRun(runId: string): Promise<RunView | null> {
    return engineRuns(this.#runsSource).get(runId);
  }

  readRuns(query?: RunQuery): Promise<readonly RunView[]> {
    return engineRuns(this.#runsSource).list(query);
  }

  #resultOf(runId: string): Promise<unknown> {
    return this.#launcher.resultOf(runId);
  }

  async readUsage(): Promise<UsageRecords> {
    const runs = (await this.runs()).map((record): ReconciledRun => {
      const { timestamps } = record;
      const ended = timestamps.completedAt ?? timestamps.failedAt;
      const unwritten =
        TERMINAL_RUN_STATUSES.has(record.status) &&
        this.#live().following(record.id);
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

  runs(): Promise<readonly RunRecord[]> {
    return this.#live().records();
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
    options: { readonly onHanded?: (runId: string) => void } = {}
  ): Promise<{ readonly ended: Promise<void> }> {
    const running = this.#running;
    if (running === undefined) {
      return { ended: Promise.resolve() };
    }
    this.#retiring = true;
    this.#launcher.beginRetiring();
    try {
      for (const runId of await this.#launcher.handOver(successor)) {
        options.onHanded?.(runId);
      }
    } catch (error) {
      this.#print(`[engine] the run queue did not retire: ${String(error)}`);
    }
    await this.#delivery.stop({ grace: 0 }).catch((error: unknown) => {
      this.#print(
        `[engine] the delivery claim was not given up as this engine retires: ${String(error)}`
      );
    });
    return { ended: this.#launcher.idle() };
  }

  async adoptQueued(
    runId: string,
    owner: ProcessIdentity
  ): Promise<QueuedAdoption> {
    if (this.#running === undefined || this.#phase !== "started") {
      return { taken: false, why: "this engine is not running" };
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `retire` sets it.
    if (this.#retiring) {
      return { taken: false, why: "this engine is retiring" };
    }
    return await this.#launcher.adoptQueued(runId, owner);
  }

  async takeHanded(runId: string): Promise<boolean> {
    if (
      this.#running === undefined ||
      this.#phase !== "started" ||
      this.#retiring
    ) {
      return false;
    }
    return (await this.#launcher.takeHanded(runId)) ?? false;
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
    this.#launcher.close(
      new Error("engine is stopping"),
      cancel ? undefined : { externalOnly: true }
    );
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

  async #stop(running: QueuedWorkflows, cancel: boolean): Promise<void> {
    let cancelling = cancel;
    let ended = false;
    const cancelAll = async () => {
      this.#launcher.close(new Error("engine is stopping"));
      await this.#launcher.cancelPending();
      await running.cancelFollowed();
    };
    this.#cancelStopping = async () => {
      if (cancelling || ended) {
        return;
      }
      cancelling = true;
      await cancelAll();
    };
    try {
      if (cancel) {
        await cancelAll();
      }
      await this.#delivery.stop();
      await this.interactions.close();
      await running.cancelQuestions();
      if (cancelling) {
        await cancelAll();
      }
      await this.#launcher.idle();
      await running.drain();
      await running.settle();
    } finally {
      ended = true;
      this.#launcher.close(new Error("engine is stopping"));
      this.#executions.detach();
      await running.stop();
      await this.#executions.flush();
    }
  }

  stream(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined {
    return this.#running?.stream(runId, signal);
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
    this.#launcher.close(new Error("engine is stopping"));
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
