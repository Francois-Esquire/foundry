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
import { Delivery } from "~/lib/events/delivery";
import type { WorkspaceRecords } from "~/lib/events/records";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import type { Handler, Source } from "~/lib/events/source";
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
import type { DispatchedRun, Launched, LaunchOptions } from "~/lib/launcher";
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

/**
 * The engine: the one place the packages meet. It is handed the instances
 * the packages give a host (models, a session store, a workspace system,
 * containers, an artifact system), each already configured for the machine
 * it runs on, and builds everything that connects them: the managers a step
 * body sees, the feed, agent approvals and activity, the triggers agents
 * create, and a real Orchestrator over its run store (`runs`).
 *
 * What can run is told to it with `define`, `schedule`, `monitor` and
 * `task`. Every launch is an Execution Run (`executions`), which the
 * launcher (`lib/launcher.ts`) records when it is queued, lets in by its
 * named queue, and records as it starts, reports and settles. A workflow is
 * then dispatched here as a Run through the Orchestrator under the same id,
 * so Runs, Jobs and frames all exist and can be inspected, and followed as
 * a held run (`lib/held-runs.ts`); a task runs its body in the launcher.
 * Every change to a Run commits to the run store as it is made, with what
 * its scope recorded beside it. In a durable store (the Marbles
 * database's) a Run parked on a question is adopted by the next process
 * that can answer it, as `lib/run-recovery.ts` decides: the Orchestrator
 * re-parks it, its scope gets the ledger it recorded, and its question
 * stays open on the feed. In memory, nothing survives the process.
 *
 * The workspace's tasks are reached here too, with the changes they
 * record, through the `records` the host hands in, or in memory; `observe`
 * says who receives those changes, and delivery runs from a successful
 * `start` until `stop`.
 */

export interface EngineOptions {
  /**
   * Where each agent harness activity is kept for the dashboard, its
   * latest revision each. Only in the engine's memory when omitted; the
   * `Engine` the package publishes keeps them in a Marbles database when
   * `state` is set.
   */
  readonly activityStore?: ActivityStore;
  /**
   * Where approvals agents left waiting for a person are kept across
   * restarts. In memory when omitted; the `Engine` the package publishes
   * keeps them in a Marbles database when `state` is set.
   */
  readonly approvals?: DeferredApprovalStore;
  /** Read by `artifacts.latest` when `artifacts` has nothing: the real store under `--dry-run`. */
  readonly artifactReads?: Pick<ArtifactSubstrate, "get" | "readFile">;
  /**
   * Versioned outputs and the feed. One system may serve many workspaces;
   * the Marbles process hands each workspace a system of its own, over its
   * scope of the Marbles database.
   */
  readonly artifacts: ArtifactSubstrate;
  /**
   * Whether someone can answer `ask` in this process (a dashboard).
   * Otherwise a question cancels its run rather than pausing it forever, and
   * parked runs from earlier processes are left for a process that can.
   */
  readonly askable?: boolean;
  /**
   * Where the triggers agents create are kept, by id. In memory when
   * omitted; the `Engine` the package publishes keeps them in a Marbles
   * database when `state` is set.
   */
  readonly automationStore?: AutomationStore;
  /**
   * The container rows kept, read without starting the runtime, so a
   * start takes back the rows, and their VMs, whose holder is gone
   * (`lib/crash-recovery.ts`). The host that keeps the rows durably gives
   * them; without them no container is taken back.
   */
  readonly containerRows?: Pick<ContainerStore, "list">;
  /**
   * Where sandboxes run. A function is called at the first sandbox and its
   * result kept, for a runtime that is optional or slow to start.
   */
  readonly containers: Containers | (() => Promise<Containers>);
  /**
   * Where the workspace's runs start, and its commands run, unless a
   * worktree narrows it; `root` when omitted.
   */
  readonly cwd?: string;
  /**
   * Simulation: an agent asked to run in a sandbox runs in this process on
   * `models` instead, so no guest is prepared and no credential is read.
   */
  readonly dry?: boolean;
  /**
   * What the workspace's commands inherit: the machine's environment with
   * the workspace's own values. This process's environment, as it is when
   * the engine is built, when omitted.
   */
  readonly environment?: Readonly<Record<string, string>>;
  /**
   * Where every run's Execution Run is kept, with its observations, and
   * what pruning removed. In memory when omitted; the `Engine` the package
   * publishes keeps them in a Marbles database when `state` is set.
   */
  readonly executionStore?: ExecutionStore;
  /**
   * How git runs: on the root workspace, and in the `git()` layer of the
   * workspace system the engine builds when `workspaces` is omitted. A host
   * that brings its own system gives this what that layer was built with;
   * the system cannot hand its git back for a path without registering and
   * scanning it, and the root workspace stays unread until a step needs it.
   */
  readonly git?: GitOptions;
  /**
   * Where the agent grants a person issued are kept, one document the
   * engine validates before it trusts it. Without it grants last as long
   * as the engine; the `Engine` the package publishes keeps them in a
   * Marbles database when `state` is set.
   */
  readonly grants?: GrantDocumentStorage;
  /** The user's home, whose skill folders `skills.load()` reads; the OS home by default. */
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
  /** The provider configuration that keeps `models` current, when the host has one. */
  readonly providers?: ProviderConfiguration;
  /**
   * Named queues and their concurrency. A queue a launch names that is not
   * here runs one run at a time; so does the default, `marbles`, unless it
   * is given here. Change them live with `executions.configure`.
   */
  readonly queues?: Readonly<Record<string, QueueSettings>>;
  /**
   * This workspace's tasks and the changes they record, which delivery
   * hands to observers. When omitted, the `Engine` the package publishes
   * (`@foundry.sh/marbles/engine` and `/lib`) keeps them in a Marbles
   * database when `state` is set, and in memory otherwise;
   * `MemoryWorkspaceRecords` keeps them in memory on purpose.
   */
  readonly records?: WorkspaceRecords;
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
  /**
   * Where the last start's recovery report is kept (`RecoveryReport`), for
   * `marbles status`. Only the engine holds it when omitted; the `Engine`
   * the package publishes keeps it in a Marbles database when `state` is set.
   */
  readonly recoveryLog?: RecoveryLog;
  /** The workspace root: where definitions resolve paths from. */
  readonly root: string;
  /**
   * Where workflow Runs are kept, with what each run's scope recorded and
   * which engine owns it. In memory when omitted: nothing outlives the
   * process, and no parked run is adopted at start. The `Engine` the
   * package publishes keeps them in a Marbles database when `state` is set.
   */
  readonly runs?: RunStore;
  /** Where agent transcripts live. */
  readonly sessions: SessionStore;
  /**
   * Where the processes this one belongs to record the children they
   * start (`MARBLES_SPAWN_RECOVERY`), so a start stops what one that is
   * gone left running (`lib/crash-recovery.ts`). The Marbles process hands
   * its engine generations one; without it no child is stopped.
   */
  readonly spawned?: string;
  /**
   * Workspace state dir: each run's output and worktrees, and, with the
   * published `Engine`, the Marbles database's stores. Omit for in-memory:
   * nothing survives the process.
   */
  readonly state?: string;

  /**
   * Where each schedule and monitor keeps its last tick, a monitor what it
   * last saw, and the claim that keeps two ticks of one trigger apart. In
   * memory when omitted; the `Engine` the package publishes keeps them in
   * a Marbles database when `state` is set.
   */
  readonly triggers?: TriggerStore;
  /**
   * Where each agent turn's usage fact is kept. In memory when omitted;
   * the `Engine` the package publishes keeps them in a Marbles database
   * when `state` is set.
   */
  readonly usageStore?: UsageStore;
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
 * How usage recovery finds sessions in `sessions`: through its listing when
 * it has one (`ListedSessionStore`). A store that cannot list them is read
 * only where a record names a session; that misses a session
 * whose only record was a `lost` marker held in memory by an earlier
 * process. That needs both the ledger and the sessions to outlive the
 * process, so a store kept in memory, or a ledger kept in memory, is not
 * flagged: neither outlives the markers. A store this cannot place is
 * assumed to outlive it.
 */
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

/**
 * The stores an engine keeps its state in: those the host gave, else each
 * in memory. The published `Engine` hands its own over a Marbles
 * database when it has a `state`.
 */
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

/**
 * What a run recorded, for usage recovery: from its scope while this
 * process holds it, which is ahead of the store, else from `runs`; a
 * record the store cannot read is `unreadable`.
 */
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

/** What a started engine holds; absent until `start` and after a failed one. */
/** How often a retired engine looks again for the runs still running here. */
const RETIRED_POLL_MS = 250;

interface Running {
  readonly held: HeldRuns;
  /** The Runs `runs()` lists. */
  readonly listing: RunListing;
  readonly orchestrator: Orchestrator;
  readonly router: FeedRouter;
  /** The workflow records the Orchestrator keeps its Runs in, over `runs`. */
  readonly store: ExecutionCoordinator;
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
  /**
   * What every run and observer here executes as: this workspace, where its
   * work starts, and the environment its commands inherit.
   */
  readonly context: ExecutionContext;
  /** Every run's lifecycle record, and the named queues they wait in. */
  readonly executions: ExecutionRuns;
  /** Feed entries from every workspace in the artifact system, newest first: in the Marbles process, this workspace's alone. */
  readonly feed: FeedReader;
  /** Approvals and questions from agents, answered through the feed. */
  readonly interactions: HarnessInteractions;
  readonly models: ModelManager;
  /** Airplane Mode for this engine's models only; off until a host turns it on. */
  readonly airplane: AirplaneMode;
  /** Which providers exist here and in what order, when the host configured them. */
  readonly providers: ProviderConfiguration | undefined;
  readonly root: string;
  readonly sandboxes: SandboxesManager;
  /** The scope of every run this engine holds, for hosts that steer or inspect. */
  readonly scopes: ReadonlyRunScopes;
  readonly sessions: SessionStore;
  readonly state: string | undefined;
  /** Each trigger's last tick, each monitor's state, and their tick claims. */
  readonly triggers: TriggerStore;
  /** What each agent turn consumed, one fact per turn. */
  readonly usage: UsageLedger;
  /**
   * This workspace's tasks, for a `Tasks` to be built over. Each commit
   * records the change it makes in the same write. Refused once the engine
   * is disposed.
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
  /** Set once `retire` began: nothing let go comes back here. */
  #retiring = false;
  /**
   * The runs this engine let go for another to take over: handed on as it
   * retired, parked after it retired, or given back by an adoption that
   * found it retiring. Nothing here answers or resumes them again.
   */
  readonly #letGo = new Set<string>();
  #disposing: Promise<void> | undefined;
  readonly #unwatch: () => void;
  readonly #unwatchRecords: () => void;
  /** The models.dev load the usage ledger prices from: held while running and online. */
  #prices: ModelsDevHold | undefined;

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
    // Started now, so list prices are there by the first turn; nothing
    // waits for it. Airplane Mode gives it up, and leaving it holds it again.
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
          // Back online, the servers are asked for their models again.
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
    this.context = {
      cwd: options.cwd ?? root,
      environment: options.environment ?? environmentSnapshot(),
      workspaceId,
    };
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
      print,
      records: this.#records,
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
          signal: () => frame.signal,
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

  /** A pruned workflow run's output, then its Run, go before its record. */
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

  /** Harness ids agents can route to on this machine, in preference order. */
  get harnesses(): readonly string[] {
    return [
      ...new Set(
        this.models.providers
          .filter((provider) => provider.available)
          .map((provider) => harnessOf(provider.id))
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

  /** What this engine's start puts right after a crash (`lib/crash-recovery.ts`). */
  #recoveryOf(
    options: EngineOptions,
    print: (line: string) => void,
    runs: RunStore
  ): CrashRecovery {
    const { containerRows, spawned } = options;
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
    // Before anything runs, so a listed model can be named from the first turn.
    await this.#listModels();
    const config = new Config();
    contributeQueueConfig(config, {
      concurrency: ORCHESTRATOR_CONCURRENCY,
      defaultName: DEFAULT_QUEUE,
    });
    let orchestrator: Orchestrator | undefined;
    let adopted: ReadonlyMap<string, RecordedScope> = new Map();
    try {
      // What the dashboard shows of agents' activities, before any runs;
      // a store that cannot be read fails the start.
      await this.activities.load();
      // The run records are read before anything is adopted into them, and
      // ones that cannot be read fail the start.
      await this.#executions.load();
      const store = new ExecutionCoordinator({
        store: await this.#runs.open(
          (runId) => this.#scopes.get(runId)?.recorded(),
          (runId, status) => this.#executions.follows(runId, status)
        ),
      });
      // Only runs under a name that is registered by now are adopted: one
      // whose definition is gone would fail the Orchestrator's start.
      adopted = await adoptParkedRuns({
        askable,
        print,
        registered: (name) => this.#registered(name),
        runs: this.#runs,
        // A run cancelled after its process exited (see
        // `Executions.cancelOrphan`) keeps its parked Run.
        settled: (runId) => this.#executions.storedSettled(runId),
        store,
      });
      for (const [runId, scope] of adopted) {
        this.#scopes.recover(runId, scope);
      }
      const statuses = await workflowStatuses(store, this.#executions.list());

      orchestrator = new Orchestrator({
        config,
        // Only what was adopted, as the claim found it: parked.
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

      // Follow each parked run adopted and keep its question open under
      // this process before abandoned entries are swept.
      for (const runId of adopted.keys()) {
        const dispatched = await orchestrator.get(runId);
        const record = await store.getRun(runId);
        if (!(dispatched && record)) {
          // Nothing here can follow it, so nothing here should own it.
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
      // A crashed dashboard never cancelled its open questions; nothing can answer them now.
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
        // A run parked before Execution Runs existed gets one now, before
        // anything it does is recorded on it.
        await this.#executions
          .adoptParked({ createdAt, id: dispatched.id, name })
          .catch((error: unknown) =>
            print(
              `[state] run ${dispatched.id} has no record: ${String(error)}`
            )
          );
        this.#launcher.follow(dispatched.id, held.follow(name, dispatched));
      }
      // Before anything is let in, so a handler never runs on an engine
      // that failed to start.
      await this.#delivery.start();
      // Started before recovery: a readmitted body runs at once and may launch.
      this.#phase = "started";
      // Last, so a start that fails leaves an exited process's queued runs
      // queued and never starts their bodies.
      await this.#recover(
        new Set(recovered.map(({ dispatched }) => dispatched.id)),
        statuses
      );
      // Once the Execution Runs of exited processes have settled, and
      // before the host schedules anything: what a crash left.
      const recovery = await this.#crashRecovery.recover(store);
      for (const runId of recovery.closed) {
        // Settled now, after the listing read the settled ones.
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
          // Whatever recovery let in before it failed stops with the start.
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
        // Nothing here owns a run now; a later start may adopt them.
        await this.#runs.release().catch(() => undefined);
      }
      throw error;
    }
    return this;
  }

  /** Take over the Execution Runs of processes that have exited (see `Launcher.recover`). */
  #recover(
    adopted: ReadonlySet<string>,
    statuses: ReadonlyMap<string, string>
  ): Promise<void> {
    return this.#launcher.recover({
      adopted,
      // A Run committed just before a crash can be ahead of its record.
      fileStatus: (run) =>
        run.kind === "workflow" ? statuses.get(run.id) : undefined,
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
      // Withdrawn, or refused, after its factory built the tree: nothing
      // will follow the run, so what its setup opened closes here.
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
   * its body never starts, and what its setup opened is closed; this still
   * waits for its factory (the definition's input validation and `setup`)
   * to resolve, since nothing hands the factory a signal. A run whose
   * process exited and that no process adopted is recorded cancelled here.
   * A task is settled when this returns; a run that has already settled is
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
    // A retiring engine resumes nothing: a parked run is let go, or about
    // to be, and the engine taking it resumes it.
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
    // Let go, or retiring, while the pauses were read: the engine taking
    // it resumes it.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `retire` sets it.
    if (this.#retiring || this.#letGo.has(runId)) {
      throw new QuestionMovingError(runId);
    }
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
      // At the revision read: one taken over meanwhile is refused as stale.
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
      // Settled here but its scope still held: read from the scope, afresh.
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
    // Read again: a fact saved while the transcripts were read outranks its recovered leaf.
    return withRecovered(await this.usage.read(), found);
  }

  /**
   * The workspace's settled Runs the store retained at start, and every Run
   * this engine dispatched or adopted since, oldest first (see
   * `RunListing`), each one still held here as it stands now.
   */
  /** What this engine's start put right after a crash, step by step; `undefined` before it started. */
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

  /**
   * The live triggers: what the host scheduled, plus what agents created,
   * read afresh, so one another process created or removed is in or out.
   */
  schedules(): Promise<readonly Schedule[]> {
    return this.automations.schedules();
  }

  /** Hand a prompt to the agent turn running in a step; it becomes the next message. */
  steer(runId: string, stepId: string, prompt: string): void {
    this.#scopeOf(runId).steer(stepId, prompt);
  }

  /**
   * Make way for `successor`, the engine that takes this workspace over in
   * another process, while what runs here goes on to its end: no change is
   * delivered here again (the claim is given up, for it to take), every
   * queued run is handed to it (`Launcher.handOver`), and every parked run
   * is let go, its claim and its open questions, for it to adopt when it
   * starts. A run still running here that parks later is let go the moment
   * it parks, and `onLetGo` is told, so the engine already running there
   * can take it over (`adopt`): nothing parked is ever held here again, and
   * every answer is refused (`QuestionMovingError`). Every step that moves
   * work comes before any that waits on author code: the queue is handed
   * over and parked runs let go first, and an observer still handling a
   * change is waited for only in `ended`. Resolves once the first of that
   * is written, with `ended`, which resolves once every run left here has
   * ended or been let go and no handler runs here; then `stop` finds
   * nothing to wait for. The delivery claim is given up once that handler
   * ends. On an engine that has not started, `ended` has resolved already.
   */
  async retire(
    successor: ProcessIdentity,
    options: {
      /** A queued run handed over after the first hand-over. */
      readonly onHanded?: (runId: string) => void;
      readonly onLetGo?: (runId: string) => void;
    } = {}
  ): Promise<{ readonly ended: Promise<void> }> {
    const running = this.#running;
    if (running === undefined) {
      return { ended: Promise.resolve() };
    }
    // Before anything is awaited: from here no run from outside this
    // engine's active runs starts here, and no answer is applied here.
    this.#retiring = true;
    this.#launcher.beginRetiring();
    running.router.retire();
    // No change is delivered here from now on; a handler still running is
    // waited for only once the work has moved (`ended`): handing a run to
    // the successor never waits on author code.
    const delivered = this.#delivery.stop().catch((error: unknown) => {
      this.#print(`[engine] delivery did not stop cleanly: ${String(error)}`);
    });
    const handedLate = (late: string) => options.onHanded?.(late);
    for (const runId of await this.#launcher.handOver(successor, handedLate)) {
      this.#letGo.add(runId);
    }
    // Every run that parks from now on goes too, as soon as it has parked.
    running.orchestrator.on("suspended", ({ runId }) => {
      if (
        this.#letGo.has(runId) ||
        running.held.workflow(runId) === undefined
      ) {
        return;
      }
      this.#giveBack(running, runId)
        .then(() => options.onLetGo?.(runId))
        .catch((error: unknown) =>
          this.#print(`[run] ${runId} not let go: ${String(error)}`)
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
    return {
      ended: Promise.all([runsEnded, delivered]).then(() => undefined),
    };
  }

  /**
   * Take the queued run `runId`, whose owner `owner` is gone, and let it in
   * here: decided in the transaction that writes it, which checks it is
   * still queued and still `owner`'s, exactly (`Launcher.takeOrphaned`).
   * `false`, changing nothing, when this engine is not running or has begun
   * to retire, `owner` is not proved gone, or the run moved meanwhile.
   */
  async takeQueued(runId: string, owner: ProcessIdentity): Promise<boolean> {
    if (this.#running === undefined || this.#phase !== "started") {
      return false;
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `retire` sets it.
    if (this.#retiring) {
      return false;
    }
    return await this.#launcher.takeOrphaned(runId, owner);
  }

  /**
   * Take over the parked Run `runId`, which an engine of this workspace in
   * another process let go as it retired (`retire`), while this one runs:
   * claimed as a start claims the parked Runs it adopts, its Execution Run
   * made this process's, rebuilt in the Orchestrator and followed to its
   * end here, its open question answerable here. Resolves whether this
   * engine holds it now: `false`, holding nothing, when it is not parked,
   * another live engine holds it, nothing here can answer it, or this
   * engine is not running or is itself retiring. A queued run another
   * engine handed to this one after this one started is let in here
   * instead (`Launcher.takeHanded`).
   */
  async adopt(runId: string): Promise<boolean> {
    const running = this.#running;
    // Retirement may begin at any wait below: looked at again after each.
    const away = () =>
      this.#running !== running || this.#phase !== "started" || this.#retiring;
    if (running === undefined || away()) {
      return false;
    }
    // A queued run handed here after this engine started: let it in.
    const handed = await this.#launcher.takeHanded(runId);
    if (handed !== undefined) {
      return handed;
    }
    const record = await running.store.getRun(runId);
    if (record?.status !== "suspended" || away()) {
      return false;
    }
    // Said by whoever offered it, through what this answers: not here.
    const scope = await adoptParkedRun(record, {
      askable: this.#askable,
      print: () => undefined,
      registered: (name) => this.#registered(name),
      runs: this.#runs,
      settled: (id) => this.#executions.storedSettled(id),
      store: running.store,
    });
    if (scope === undefined) {
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
      // Given back, unanswered here: for the engine taking over, whose
      // start, or whose next adoption, finds it parked and unowned.
      this.#scopes.forget(runId);
      await this.#giveBack(running, runId).catch(() => undefined);
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
    // In the same turn as the last look: a retirement that begins after
    // this finds the run held here, and lets it go with the rest.
    this.#print(`[run] ${record.step} taken over ${runId}`);
    running.listing.add(runId);
    this.#launcher.follow(runId, running.held.follow(record.step, dispatched));
    return true;
  }

  /**
   * Let a parked run go for another engine to take over: its open
   * questions forgotten here, its claim given up, and nothing here
   * answers or resumes it again.
   */
  async #giveBack(running: Running, runId: string): Promise<void> {
    this.#letGo.add(runId);
    running.router.letGo(runId);
    await this.#runs.release(runId);
  }

  /**
   * Settle and write what this process holds. Without `cancel`, queued runs
   * are let in and run to their end, as before a stop. `cancel` stops work
   * that cannot outlive the process: queued and running runs, and, in a
   * run store that does not outlive it, parked ones too. In a durable one a
   * parked run keeps its question and is adopted by the next process that
   * can answer. A task
   * that gave up its slot, a long-lived one, is always stopped, and is
   * stopped before anything is waited on. A workflow still being set up is
   * waited on: its factory is handed no signal, so a `setup` that never
   * resolves keeps the stop, and `dispose`, from resolving. Does nothing
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
      if (cancel) {
        this.#launcher.cancelPending();
      }
      // A running handler finishes first: it may still call into this engine.
      await this.#delivery.stop();
      await this.interactions.close();
      // In a durable run store a parked run is adopted by the next process
      // that can answer, so a quit keeps it and its open question. In
      // memory, cancel open questions because no later process can resume
      // the run.
      const parkedSurvive = this.#runs.durable;
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
        // Every change to a record made so far is on disk, and every
        // settlement a write failed is tried again: one that still fails
        // fails the stop.
        await this.#executions.flush();
        await this.#executions.retrySettlements();
      } finally {
        // What is parked is left for the next process that can answer it.
        await this.#runs.release();
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
   * Ask the providers that list their models for them, and reload. Never
   * rejects: a problem is printed, and the set loaded before is kept.
   */
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

  /** Give up the models.dev load; one still fetching is aborted when no other engine holds it. */
  #releasePrices(): void {
    this.#prices?.release();
    this.#prices = undefined;
  }

  /**
   * Stop execution and close what this engine was handed: the workspace system,
   * the containers if a sandbox ever opened them, and the models. The models
   * go last and always: a provider may hold a child process. Its cancelling
   * stop waits for a workflow's `setup` in flight, as `stop` does.
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
    // Last: a turn its agents finished may still be recording its usage.
    await close(() => this.#usageStore.close());
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose the engine");
    }
  }
}
