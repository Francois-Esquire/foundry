import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "@foundry/agents/authorization";
import type { SessionStore } from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/session";
import type { Artifacts as ArtifactSubstrate } from "@foundry/artifacts";
import { Config } from "@foundry/lib/config";
import type { ModelManager } from "@foundry/models";
import type { Containers } from "@foundry/sandbox/container/containers";
import type { TaskStore } from "@foundry/tasks";
import type { ChannelMessage } from "@foundry/workflows/channels";
import { contributeQueueConfig } from "@foundry/workflows/config";
import type { BaseContext } from "@foundry/workflows/executable";
import type { Factory } from "@foundry/workflows/orchestrator";
import { Orchestrator } from "@foundry/workflows/orchestrator";
import type { RunRecord } from "@foundry/workflows/store";
import { InMemoryOrchestratorStore } from "@foundry/workflows/store";
import { WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";

import { configuredMonitorUrl } from "~/lib/automation/configured";
import { AutomationService } from "~/lib/automation/service";
import type { Bindings } from "~/lib/bindings";
import { commandRunner } from "~/lib/command";
import type { AnyDefinition } from "~/lib/definition";
import { Delivery } from "~/lib/events/delivery";
import { WorkspaceRecords } from "~/lib/events/records";
import type { Handler, Source } from "~/lib/events/source";
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
import { feedRouter } from "~/lib/feed/route";
import type { Dispatched } from "~/lib/held-runs";
import { HeldRuns } from "~/lib/held-runs";
import type { DispatchedRun, Launched, LaunchOptions } from "~/lib/launcher";
import { Launcher } from "~/lib/launcher";
import { createLog, type LogLevel, type LogOrigin } from "~/lib/log";
import { AgentsManager } from "~/lib/managers/agents";
import { ArtifactsManager } from "~/lib/managers/artifacts";
import { SandboxesManager } from "~/lib/managers/sandboxes";
import { globalSkillsDir, skillResolver } from "~/lib/managers/skills";
import type { Catalogue, GitOptions } from "~/lib/managers/workspaces";
import { WorkspacesManager } from "~/lib/managers/workspaces";
import type { DefinitionEntry, MonitorRecord } from "~/lib/registry";
import { Registry } from "~/lib/registry";
import type { ReadonlyRunScopes } from "~/lib/run-scope";
import { PAUSE_KIND, RunScopes, workingDirectory } from "~/lib/run-scope";
import { HarnessActivities } from "~/lib/sandbox/activities";
import { JsonAgentGrantRepository } from "~/lib/sandbox/grants";
import { HarnessInteractions } from "~/lib/sandbox/interactions";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import type { Lock } from "~/lib/state/locks";
import {
  isTerminalRunStatus,
  loadRuns,
  readRunRecorded,
  removeRun,
  TERMINAL_RUN_STATUSES,
} from "~/lib/state/runs";
import type { StateStore } from "~/lib/state/store";
import { InMemoryStateStore, JsonStateStore } from "~/lib/state/store";
import type { TaskDefinition } from "~/lib/tasks";
import { factoryFor } from "~/lib/tree";
import type { Schedule } from "~/lib/triggers";
import type { UsageRecords } from "~/lib/usage";
import { UsageLedger, withRecovered } from "~/lib/usage";
import type { ReconciledRun, SessionListing } from "~/lib/usage-evidence";
import { UsageEvidence } from "~/lib/usage-evidence";

/**
 * The engine: the one place the packages meet. It is handed the instances
 * the packages give a host (models, a session store, a workspace system,
 * containers, an artifact system), each already configured for the machine
 * it runs on, and builds everything that connects them: the managers a step
 * body sees, the feed, agent approvals and activity, the triggers agents
 * create, and a real Orchestrator over an in-memory store.
 *
 * What can run is told to it with `define`, `schedule`, `monitor` and
 * `task`. Every launch is an Execution Run (`executions`), which the
 * launcher (`lib/launcher.ts`) records when it is queued, lets in by its
 * named queue, and records as it starts, reports and settles. A workflow is
 * then dispatched here as a Run through the Orchestrator under the same id,
 * so Runs, Jobs and frames all exist and can be inspected, and followed as
 * a held run (`lib/held-runs.ts`); a task runs its body in the launcher.
 * Given a state dir, the store hydrates from `runs/*.json` at start and each
 * Run is written back when it parks and once it settles; without one,
 * nothing survives the process. A Run parked on a question is adopted by
 * the next process that can answer it: the Orchestrator re-parks it, its
 * scope gets the ledger it recorded, and its question stays open on the
 * feed.
 *
 * The workspace's tasks are kept here too, with the items their changes
 * emit, in `<state>/tasks.json` or in memory; `observe` says who receives
 * those items, and delivery runs from a successful `start` until `stop`.
 */

export interface EngineOptions {
  /** Read by `artifacts.latest` when `artifacts` has nothing: the real store under `--dry-run`. */
  readonly artifactReads?: ArtifactSubstrate;
  /** Versioned outputs and the feed; one system may serve many workspaces. */
  readonly artifacts: ArtifactSubstrate;
  /**
   * Whether someone can answer `ask` in this process (a dashboard).
   * Otherwise a question cancels its run rather than pausing it forever, and
   * parked runs from earlier processes are left for a process that can.
   */
  readonly askable?: boolean;
  /**
   * Where sandboxes run. A function is called at the first sandbox and its
   * result kept, for a runtime that is optional or slow to start.
   */
  readonly containers: Containers | (() => Promise<Containers>);
  /**
   * Simulation: an agent asked to run in a sandbox runs in this process on
   * `models` instead, so no guest is prepared and no credential is read.
   */
  readonly dry?: boolean;
  /**
   * How git runs: on the root workspace, and in the `git()` layer of the
   * workspace system the engine builds when `workspaces` is omitted. A host
   * that brings its own system gives this what that layer was built with;
   * the system cannot hand its git back for a path without registering and
   * scanning it, and the root workspace stays unread until a step needs it.
   */
  readonly git?: GitOptions;
  /** The user's home, for skills shared across workspaces; the OS home by default. */
  readonly home?: string;
  /**
   * Where definitions' own `log(...)` lines go, with where each came from:
   * a step body (whose run also records the line) or a workflow's setup
   * (which no run record keeps). To `print` when omitted. A host that lists
   * runs' logs itself can keep them apart from its own lines.
   */
  readonly log?: (level: LogLevel, message: string, origin: LogOrigin) => void;
  /** Every provider agents may route to, already registered. */
  readonly models: ModelManager;
  /** One line of engine status at a time, and body `log(...)` without `log`; dropped when omitted. */
  readonly print?: (line: string) => void;
  /**
   * Named queues and their concurrency. A queue a launch names that is not
   * here runs one run at a time; so does the default, `marbles`, unless it
   * is given here. Change them live with `executions.configure`.
   */
  readonly queues?: Readonly<Record<string, QueueSettings>>;
  /**
   * Whether queued runs a process that has exited left behind are let in
   * again at start, in their original order, when their definition or task
   * is registered by then. Off by default: they stay queued and visible
   * until a process that recovers them starts, or they are cancelled. A
   * queued run has had no effect and keeps its input, so a workflow is
   * replayed from it; a host whose task bodies lived only in the exited
   * process turns this on to settle each such run explicitly, as its body
   * decides (Works fails them as abandoned), rather than leave it queued.
   */
  readonly recoverQueued?: boolean;
  /** The workspace root: where definitions resolve paths from. */
  readonly root: string;
  /** Where agent transcripts live. */
  readonly sessions: SessionStore;
  /** Workspace state dir. Omit for in-memory: nothing survives the process. */
  readonly state?: string;
  /**
   * Where triggers keep their history, monitors what they saw, and agents
   * the triggers they create, with the locks that keep two ticks apart. By
   * default a `JsonStateStore` over `state`, or in memory without one.
   */
  readonly store?: StateStore;
  /** Identity of this workspace: part of a declared artifact's id and of every feed entry. */
  readonly workspaceId: string;
  /**
   * Directories and repositories, with the `directory` and `git` layers. By
   * default a system over the local filesystem, watched, whose git runs as
   * `git` says.
   */
  readonly workspaces?: Catalogue;
  /**
   * Where worktrees are cut when a step names no `home`; by default
   * `Engine.worktreesFor(state)`.
   */
  readonly worktrees?: string;
}

/**
 * How usage recovery finds sessions in `sessions`. A store that cannot list
 * them is read only where a record names a session; that misses a session
 * whose only record was a `lost` marker held in memory by an earlier
 * process. That needs both the ledger and the sessions to outlive the
 * process, so a store kept in memory, or a ledger kept in memory, is not
 * flagged: neither outlives the markers. A store this cannot place is
 * assumed to outlive it.
 */
function sessionListing(
  sessions: SessionStore,
  store: StateStore
): { readonly stamps?: SessionListing } {
  if (sessions instanceof JsonSessionStore) {
    return { stamps: () => sessions.stamps() };
  }
  const outlives = !(
    sessions instanceof InMemorySessionStore ||
    store instanceof InMemoryStateStore
  );
  return outlives ? { stamps: "unavailable" } : {};
}

/** What a started engine holds; absent until `start` and after a failed one. */
interface Running {
  readonly held: HeldRuns;
  readonly orchestrator: Orchestrator;
  readonly router: FeedRouter;
  readonly store: InMemoryOrchestratorStore;
}

/**
 * The Orchestrator's own queue never holds a run back: the engine's named
 * queues have already let it in.
 */
const ORCHESTRATOR_CONCURRENCY = Number.MAX_SAFE_INTEGER;

// biome-ignore lint/performance/noBarrelFile: Preserve the existing engine error export after moving run tracking.
export { RunEndedError } from "~/lib/held-runs";

export class Engine {
  /** What agents inside sandboxes are doing, for a host that shows it. */
  readonly activities: HarnessActivities;
  readonly agents: AgentsManager;
  readonly artifacts: ArtifactsManager;
  /** Triggers agents create; they join the schedules a host declared. */
  readonly automations: AutomationService;
  /** What step bodies are built from: the managers, scoped per frame. */
  readonly bindings: Bindings;
  /** Every run's lifecycle record, and the named queues they wait in. */
  readonly executions: ExecutionRuns;
  /** Feed entries from every workspace in the artifact system, newest first. */
  readonly feed: FeedReader;
  /** Approvals and questions from agents, answered through the feed. */
  readonly interactions: HarnessInteractions;
  readonly models: ModelManager;
  readonly root: string;
  readonly sandboxes: SandboxesManager;
  /** The scope of every run this engine holds, for hosts that steer or inspect. */
  readonly scopes: ReadonlyRunScopes;
  readonly sessions: SessionStore;
  readonly state: string | undefined;
  /** Trigger history, monitor state, agent-created triggers, and their locks. */
  readonly store: StateStore;
  /** What each run's agent turns consumed, one fact per turn, in `store`. */
  readonly usage: UsageLedger;
  /**
   * This workspace's tasks, for a `Tasks` to be built over. Each commit
   * stores the change it emits in the same write. Read or written, it is
   * owned by this process until `dispose`; another engine over the same
   * state dir is refused it meanwhile.
   */
  readonly taskStore: TaskStore;
  readonly workspaceId: string;
  readonly workspaces: WorkspacesManager;
  /** Where worktrees are cut; a host lets its sandboxes mount what is inside. */
  readonly worktrees: string;

  readonly #askable: boolean;
  /** Turns the usage ledger lacks, found in surviving runs and transcripts. */
  readonly #evidence: UsageEvidence;
  readonly #publisher: FeedPublisher;
  readonly #print: (line: string) => void;
  readonly #registry = new Registry();
  readonly #scopes = new RunScopes();
  /**
   * Raw factories registered beside the definitions, by name, applied in
   * order at start. Each keeps its own factory's types by registering itself.
   */
  readonly #extra = new Map<string, (orchestrator: Orchestrator) => void>();
  readonly #executions: Executions;
  readonly #launcher: Launcher;
  readonly #records: WorkspaceRecords;
  readonly #delivery: Delivery;
  readonly #directNames = new WeakMap<AnyDefinition, string>();
  #running: Running | undefined;
  #phase: "new" | "starting" | "started" | "failed" | "stopping" = "new";
  #starting: Promise<this> | undefined;
  #stopping: Promise<void> | undefined;
  #disposing: Promise<void> | undefined;

  /**
   * Where an engine over `state` cuts worktrees by default: inside the state
   * dir, or under the OS temp dir without one. A dir Marbles owns, so a host
   * may let its sandboxes mount what is inside.
   */
  static worktreesFor(state: string | undefined): string {
    return join(state ?? join(tmpdir(), "marbles"), "worktrees");
  }

  constructor(options: EngineOptions) {
    const { models, root, sessions, state, workspaceId } = options;
    const print = options.print ?? (() => undefined);
    const home = options.home ?? homedir();
    const askable = options.askable ?? false;
    const { containers } = options;
    this.models = models;
    this.root = root;
    this.scopes = this.#scopes;
    this.sessions = sessions;
    this.state = state;
    this.store =
      options.store ??
      (state === undefined
        ? new InMemoryStateStore()
        : new JsonStateStore(state));
    this.usage = new UsageLedger(this.store);
    this.#evidence = new UsageEvidence({
      // A run this process holds is read from its scope, which is ahead of its file.
      recordedOf: (runId) => {
        const scope = this.#scopes.get(runId);
        if (scope) {
          return { ledger: scope.ledger.toJSON(), session: scope.session.id };
        }
        return state === undefined ? undefined : readRunRecorded(state, runId);
      },
      sessions,
      ...sessionListing(sessions, this.store),
    });
    this.workspaceId = workspaceId;
    this.worktrees = options.worktrees ?? Engine.worktreesFor(state);
    this.#executions = new Executions({
      ...(options.queues === undefined ? {} : { queues: options.queues }),
      // A pruned workflow run's own file goes with its record.
      removed: (run) => {
        if (run.kind === "workflow" && state !== undefined) {
          removeRun(state, run.id);
        }
      },
      store: this.store,
      warn: print,
    });
    this.executions = this.#executions;
    this.#launcher = new Launcher({
      agents: (run) => this.agents.forRun(run),
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
    this.#records = new WorkspaceRecords({
      ...(state === undefined ? {} : { dir: state }),
      emitted: () => this.#delivery.wake(),
    });
    this.#delivery = new Delivery(this.#records, print);
    this.taskStore = this.#records.taskStore;
    const catalogue =
      options.workspaces ??
      new WorkspaceSystem().extend(
        directory({ observer: nodeObserver }),
        git(options.git ?? {})
      );
    this.#askable = askable;
    this.#print = print;
    this.#publisher = feedPublisher(options.artifacts, {
      id: workspaceId,
      name: basename(root),
      root,
    });
    this.feed = feedReader(options.artifacts);
    this.activities = new HarnessActivities({ feed: this.#publisher, state });
    this.automations = new AutomationService({
      allowHttp: configuredMonitorUrl(this.#registry),
      registry: this.#registry,
      store: this.store,
    });
    this.interactions = new HarnessInteractions({
      askable,
      feed: this.#publisher,
      policy: state
        ? createAgentAuthorizer({
            grants: new JsonAgentGrantRepository(
              join(state, "agent-grants.json")
            ),
          })
        : createInMemoryAgentAuthorizer().authorizer,
      sessions,
      ...(state ? { pendingPath: join(state, "agent-approvals.json") } : {}),
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
      defaultExecutor: () => selectExecutor(models),
      dry: options.dry ?? false,
      interactions: this.interactions,
      models,
      observe: (runId, observation) =>
        this.#executions.observe(runId, observation),
      root,
      sessions,
      skills: skillResolver({ global: globalSkillsDir(home), workspace: root }),
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
      gitOptions: options.git ?? {},
      root,
      worktreeHome: this.worktrees,
    });
    this.bindings = {
      agents: (args) => this.agents.scoped(args),
      artifacts: (args) => this.artifacts.scoped(args),
      exec: ({ frame, scope, write }) =>
        commandRunner({
          cwd: () => workingDirectory(scope.cwd),
          dry: options.dry ?? false,
          print,
          signal: () => frame.signal,
          write,
        }),
      host: { catalogue, store: this.store },
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

  /** Harness ids agents can route to on this machine, in preference order. */
  get harnesses(): readonly string[] {
    return [
      ...new Set(
        this.models
          .list()
          .filter((provider) => provider.available)
          .map((provider) => provider.harness)
      ),
    ];
  }

  /**
   * Add a named definition; `launch` and `run` address it by that name. One
   * defined after `start` runs like any other, but a run parked under its
   * name by an earlier process was already passed over.
   */
  define(definition: AnyDefinition): void {
    if (definition.name !== undefined) {
      this.#claim(definition.name, { definitions: false, label: "define" });
    }
    this.#registry.define(definition);
    if (definition.name !== undefined) {
      this.#adopt(definition.name);
    }
  }

  /** Once started, a definition added to the registry goes to the Orchestrator too. */
  #adopt(name: string): void {
    const definition = this.#registry.definitions.get(name);
    if (definition && this.#running) {
      this.#running.orchestrator.register(
        name,
        factoryFor(definition, () => this.bindings, this.#scopes)
      );
    }
  }

  /** Whether a definition has this name, launchable by hand or not. */
  has(name: string): boolean {
    return this.#registry.definitions.has(name);
  }

  /** The definitions a host can offer to launch: no monitor detectors. */
  definitions(): readonly DefinitionEntry[] {
    return this.#registry.entries();
  }

  /** Start a defined workflow on a cadence. */
  schedule(record: Schedule): void {
    this.#registry.schedule(record);
  }

  /**
   * Watch a source on a cadence and call the handler when it changes. The
   * monitor appears among the schedules under its key; a locked node the
   * handler returns is started by the tick that polled.
   */
  monitor(record: MonitorRecord): void {
    this.#claim(record.key, { definitions: false, label: "monitor" });
    this.#registry.monitor(record);
    this.#adopt(record.key);
  }

  /**
   * Hand every item `source` emits in this workspace to `handler`, until it
   * completes. Declared before `start`, as an authoring module's `observe`
   * is.
   */
  observe<T>(source: Source<T>, handler: Handler<T>): void {
    this.#delivery.observe(source, handler);
  }

  /** The monitors a host declared, by key. */
  monitors(): ReadonlyMap<string, MonitorRecord> {
    return this.#registry.monitors;
  }

  /**
   * Register a raw workflows factory beside the definitions, for a host step
   * that should run as a Run without being launchable by name. Before
   * `start` only: recovery needs every name before the store is built.
   */
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

  /**
   * Add a host task: a run kind that is not a workflow, launched by name
   * like a definition. A task registered after `start` runs like any
   * other, but queued runs an exited process left under its name were
   * already passed over.
   */
  task<I, O>(definition: TaskDefinition<I, O>): void {
    this.#claim(definition.name, { definitions: true, label: "task" });
    this.#launcher.task(definition as TaskDefinition);
  }

  /**
   * One name, one runnable: refuse a name a task or a raw factory already
   * holds, and a definition's too when `definitions` says so. A definition
   * or a monitor claims without it: two definitions under one name are the
   * registry's to refuse, saying where each came from. `label` names the
   * call in the error.
   */
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

  /** Whether the Orchestrator can run this name: a definition, or a raw factory. */
  #registered(name: string): boolean {
    return this.#registry.definitions.has(name) || this.#extra.has(name);
  }

  /** Every named definition, then what the host registered beside them. */
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

  /** Build the Orchestrator, register what can run, and adopt what an earlier process parked. */
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
    const config = new Config();
    contributeQueueConfig(config, {
      concurrency: ORCHESTRATOR_CONCURRENCY,
      defaultName: DEFAULT_QUEUE,
    });
    // The store is built before the Orchestrator that registers definitions,
    // and a recovered run whose definition is gone would fail the start. So
    // only runs under a name that will be registered are recovered.
    const loaded =
      state === undefined
        ? undefined
        : loadRuns(state, print, {
            recover: (run) => askable && this.#registered(run.step),
          });
    let orchestrator: Orchestrator | undefined;
    try {
      // The run store is read before anything is adopted into it, and one
      // that cannot be read fails the start.
      this.#executions.load();
      for (const [runId, extras] of loaded?.recovered ?? []) {
        this.#scopes.recover(runId, extras);
      }
      const store = new InMemoryOrchestratorStore(
        loaded === undefined ? {} : { snapshot: loaded.snapshot }
      );

      orchestrator = new Orchestrator({ config, store });
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
        store,
      });
      const recovered: {
        name: string;
        dispatched: Dispatched<unknown>;
        lock?: Lock;
      }[] = [];

      // Adopt what the store recovered: follow each parked run and keep its
      // question open under this process before abandoned entries are swept.
      for (const runId of loaded?.recovered.keys() ?? []) {
        const lock = loaded?.locks.get(runId);
        const dispatched = await orchestrator.get(runId);
        const record = store.snapshot().runs.find((run) => run.id === runId);
        if (!(dispatched && record)) {
          // Nothing here can follow it, so nothing here should own it.
          lock?.release();
          this.#scopes.forget(runId);
          continue;
        }
        print(`[run] ${record.step} recovered ${runId}`);
        recovered.push({ dispatched, lock, name: record.step });
        await router.adopt(record.step, runId);
      }
      await this.interactions.restore();
      // A crashed dashboard never cancelled its open questions; nothing can answer them now.
      await feed
        .cancelAbandoned()
        .catch((error: unknown) => print(`[feed] ${String(error)}`));
      this.#running = { held, orchestrator, router, store };
      for (const { name, dispatched, lock } of recovered) {
        this.#launcher.follow(
          dispatched.id,
          held.follow(name, dispatched, lock)
        );
        held.save(dispatched.id);
      }
      const ended = new Map(
        (loaded?.snapshot.runs ?? []).map((run) => [run.id, run.status])
      );
      this.#recover(
        new Set(recovered.map(({ dispatched }) => dispatched.id)),
        ended
      );
      // Last, so a handler never runs on an engine that failed to start.
      await this.#delivery.start();
      this.#phase = "started";
      this.#delivery.wake();
    } catch (error) {
      this.#phase = "failed";
      try {
        try {
          await this.#delivery.stop();
          await orchestrator?.stop();
        } finally {
          for (const scope of this.#scopes) {
            scope.abort(error);
            await this.#scopes.settle(scope.id);
          }
        }
      } finally {
        for (const [runId, lock] of loaded?.locks ?? []) {
          lock.release();
          this.#scopes.forget(runId);
        }
        this.#running = undefined;
      }
      throw error;
    }
    return this;
  }

  /** Take over the Execution Runs of processes that have exited (see `Launcher.recover`). */
  #recover(
    adopted: ReadonlySet<string>,
    ended: ReadonlyMap<string, string>
  ): void {
    this.#launcher.recover({
      adopted,
      // A run file written as settled just before a crash beat its record there.
      settled: (run) => {
        const status = run.kind === "workflow" ? ended.get(run.id) : undefined;
        return isTerminalRunStatus(status) ? status : undefined;
      },
    });
  }

  /** Dispatch a launched workflow run through the Orchestrator under its own id. */
  async #dispatch(
    run: ExecutionRun,
    input: unknown,
    signal: AbortSignal
  ): Promise<DispatchedRun> {
    const { orchestrator } = this.#live();
    const { correlation } = run;
    const dispatched = await orchestrator.run<unknown, unknown>(
      run.name,
      input,
      {
        extensions:
          "triggerId" in correlation
            ? { triggerId: correlation.triggerId }
            : {},
        runId: run.id,
        signal,
      }
    );
    return this.#live().held.follow(run.name, dispatched);
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

  /** Answer an open input entry; the run that asked resumes with it. */
  async answer(entryId: string, answer: FeedAnswer): Promise<void> {
    if (await this.interactions.answer(entryId, answer)) {
      return;
    }
    return this.#live().router.answer(entryId, answer);
  }

  /**
   * Cancel one run, wherever it is: off its queue if it is still waiting,
   * aborted if it is a task, and through the Orchestrator otherwise. A run
   * still being dispatched is withdrawn before the Orchestrator takes it, so
   * its body never starts; this still waits for its factory to resolve. A
   * task is settled when this returns; a run that has already settled is
   * left as it is.
   */
  cancel(runId: string): Promise<void> {
    return this.#launcher.cancel(runId);
  }

  /**
   * Launch a definition or task by name. The run is recorded as queued
   * before this returns; when its queue lets it in at once, it has also
   * started, so a bad input still rejects here. A run that has to wait is
   * started when its turn comes, and a failure to start settles its
   * `result` instead. A `source` already launched under the name returns
   * that run. A string is a trigger id, as before options.
   */
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

  /**
   * Park a running step: what it opened stops and the run shows as
   * suspended. `false` when no such step is running here.
   */
  pause(runId: string, stepId: string, reason?: string): boolean {
    return this.scopes.get(runId)?.pause(stepId, reason) ?? false;
  }

  /**
   * Resume a paused step. The body replays from the top; a prompt goes to
   * the first turn of the agent session it had open.
   */
  async resume(runId: string, stepId: string, prompt?: string): Promise<void> {
    const { orchestrator } = this.#live();
    const scope = this.#scopeOf(runId);
    const pending = await orchestrator.listSuspensions({
      kind: PAUSE_KIND,
      runId,
      status: "pending",
    });
    // A pause parks a subtree, so a resume releases every pause at or
    // under the step. The root segment of a step path is the registered
    // name here, but compare below it too, as the feed does, in case a
    // host renames it.
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
      await orchestrator.resolve(suspension.id, { prompt: trimmed ?? null });
    }
  }

  /**
   * Dispatch a registered definition and wait for its value. `input` is
   * `unknown` because names, not types, address a definition — the caller
   * states the output type it expects.
   */
  async run<O>(
    name: string,
    input: unknown,
    options?: string | LaunchOptions
  ): Promise<O> {
    const launched = await this.launch<O>(name, input, options);
    return launched.result;
  }

  /** Run a definition directly, including an anonymous one, through the engine. */
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

  /**
   * What agent turns consumed: the ledger's facts and markers, plus a
   * recovered `lost` leaf for each committed turn a session transcript shows
   * and the ledger lacks, and the transcripts and run files that could not
   * be read, as unreadable. Recovery reads transcripts and the runs' files;
   * it writes nothing. See `UsageEvidence` for what attributes a leaf.
   */
  async readUsage(): Promise<UsageRecords> {
    const runs = (await this.runs()).map((record): ReconciledRun => {
      const { timestamps } = record;
      const ended = timestamps.completedAt ?? timestamps.failedAt;
      // Settled here but not yet written back: its file is not there to read.
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
      this.usage.read(),
      runs,
      this.workspaceId
    );
    // Read again: a fact saved while the transcripts were read outranks its recovered leaf.
    return withRecovered(this.usage.read(), found);
  }

  /** Every Run this process dispatched or adopted. */
  runs(): Promise<readonly RunRecord[]> {
    const { held, store } = this.#live();
    return Promise.resolve(
      store.snapshot().runs.map((record) => {
        const current = held.workflow(record.id)?.state;
        return current
          ? {
              ...record,
              metadata: { ...record.metadata, workflow: current },
              snapshot: current.tree ?? record.snapshot,
            }
          : record;
      })
    );
  }

  /** The live triggers: what the host scheduled, plus what agents created. */
  schedules(): readonly Schedule[] {
    return this.automations.schedules();
  }

  /** Hand a prompt to the agent turn running in a step; it becomes the next message. */
  steer(runId: string, stepId: string, prompt: string): void {
    this.#scopeOf(runId).steer(stepId, prompt);
  }

  /**
   * Settle and write what this process holds. Without `cancel`, queued runs
   * are let in and run to their end, as before a stop. `cancel` stops work
   * that cannot outlive the process: queued and running runs, and, without
   * a state dir, parked ones too. With a state dir a parked run keeps its
   * question and is adopted by the next process that can answer. A task
   * that gave up its slot, a long-lived one, is always stopped. Does nothing
   * on an engine that never started.
   */
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
    this.#stopping ??= this.#stop(this.#running, options?.cancel ?? false);
    return this.#stopping;
  }

  async #stop(
    { held, orchestrator, router }: Running,
    cancel: boolean
  ): Promise<void> {
    try {
      // A running handler finishes first: it may still call into this engine.
      await this.#delivery.stop();
      await this.interactions.close();
      // With a state dir a parked run is written and adopted by the next
      // process that can answer, so a quit keeps it and its open question.
      // Without one, cancel open questions because no later process can resume the run.
      const parkedSurvive = this.state !== undefined;
      if (!parkedSurvive) {
        await router.cancelOpen();
      }
      await this.#launcher.halt(cancel);
      if (cancel) {
        const doomed = parkedSurvive
          ? ["queued", "running"]
          : ["queued", "running", "suspended"];
        await Promise.all(
          held.withStatus(doomed).map((runId) => orchestrator.cancelRun(runId))
        );
      }
      await this.#executions.drained();
      await orchestrator.drain();
      await this.#launcher.settled();
      await held.settle();
    } finally {
      try {
        await orchestrator.stop();
      } finally {
        held.releaseAll();
      }
    }
  }

  /**
   * A live run's events and chunks from its start, then as they happen;
   * `undefined` once the run is no longer held by this process.
   */
  stream(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined {
    return this.#running?.held.workflow(runId)?.root.subscribe(signal);
  }

  /**
   * Stop execution and close what this engine was handed: the workspace system,
   * the containers if a sandbox ever opened them, and the models. The models
   * go last and always: a provider may hold a child process.
   */
  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose();
    return this.#disposing;
  }

  /** Whether disposal has begun; hosts stop routing new work to this engine. */
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
    // No handler or step is left to write a task: give up the records.
    await close(() => this.#records.close());
    await close(() => this.interactions.close());
    await close(() => this.workspaces.close());
    await close(() => this.sandboxes.close());
    await close(() => this.agents.close());
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose the engine");
    }
  }
}
