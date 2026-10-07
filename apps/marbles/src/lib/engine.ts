import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "@foundry/agents/authorization";
import type { SessionStore } from "@foundry/agents/session";
import type { Artifacts as ArtifactSubstrate } from "@foundry/artifacts";
import { Config } from "@foundry/lib/config";
import type { ModelManager } from "@foundry/models";
import type { Containers } from "@foundry/sandbox/container/containers";
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
import type { AnyDefinition } from "~/lib/definition";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { FeedPublisher } from "~/lib/feed/publish";
import { feedPublisher } from "~/lib/feed/publish";
import type { FeedReader } from "~/lib/feed/read";
import { feedReader } from "~/lib/feed/read";
import type { FeedRouter } from "~/lib/feed/route";
import { feedRouter } from "~/lib/feed/route";
import { selectExecutor } from "~/lib/harnesses";
import { createLog } from "~/lib/log";
import { AgentsManager } from "~/lib/managers/agents";
import { ArtifactsManager } from "~/lib/managers/artifacts";
import { SandboxesManager } from "~/lib/managers/sandboxes";
import { globalSkillsDir, skillResolver } from "~/lib/managers/skills";
import type { Catalogue, GitOptions } from "~/lib/managers/workspaces";
import { WorkspacesManager } from "~/lib/managers/workspaces";
import { observeSteps } from "~/lib/observe";
import type { DefinitionEntry, MonitorRecord } from "~/lib/registry";
import { Registry } from "~/lib/registry";
import type { ReadonlyRunScopes } from "~/lib/run-scope";
import { PAUSE_KIND, RunScopes } from "~/lib/run-scope";
import { HarnessActivities } from "~/lib/sandbox/activities";
import { JsonAgentGrantRepository } from "~/lib/sandbox/grants";
import { HarnessInteractions } from "~/lib/sandbox/interactions";
import type { Lock } from "~/lib/state/locks";
import type { RunExtras } from "~/lib/state/runs";
import { loadRuns, saveRun, TERMINAL_RUN_STATUSES } from "~/lib/state/runs";
import type { StateStore } from "~/lib/state/store";
import { InMemoryStateStore, JsonStateStore } from "~/lib/state/store";
import { factoryFor } from "~/lib/tree";
import type { Schedule } from "~/lib/triggers";

/**
 * The engine: the one place the packages meet. It is handed the instances
 * the packages give a host (models, a session store, a workspace system,
 * containers, an artifact system), each already configured for the machine
 * it runs on, and builds everything that connects them: the managers a step
 * body sees, the feed, agent approvals and activity, the triggers agents
 * create, and a real Orchestrator over an in-memory store.
 *
 * What can run is told to it with `define`, `schedule` and `monitor`. Every
 * workflow is dispatched as a Run through the queue, so Runs, Jobs and
 * frames all exist and can be inspected. Given a state dir, the store
 * hydrates from `runs/*.json` at start and each Run is written back when it
 * parks and once it settles; without one, nothing survives the process. A
 * Run parked on a question is adopted by the next process that can answer
 * it: the Orchestrator re-parks it, its scope gets the ledger it recorded,
 * and its question stays open on the feed.
 */

export interface EngineOptions {
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
  /** Every provider agents may route to, already registered. */
  readonly models: ModelManager;
  /** One line of engine status or body `log(...)` at a time; dropped when omitted. */
  readonly print?: (line: string) => void;
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
 * A run this process dispatched or adopted, from then until it settles:
 * what a host reads of it while it is live, and what is owed on disk.
 */
interface HeldRun {
  /** Execution, publication, cleanup, and persistence, owned together. */
  finalized?: Promise<unknown>;
  /** Ownership of an adopted run's file; released once it settles or the process stops. */
  lock?: Lock;
  /**
   * Not yet written since it was dispatched. Persisting is not the run: a
   * failed write warns and the value still returns.
   */
  unsaved: boolean;
  /**
   * What is read of it while it is live. None of it depends on the run's
   * output type, which the workflow's private runtime holds invariantly.
   */
  readonly workflow: Pick<Dispatched<unknown>["workflow"], "root" | "state">;
}

/** Give up a held run's file, once: another process may take it from here. */
function release(held: HeldRun): void {
  held.lock?.release();
  held.lock = undefined;
}

/** What a started engine holds; absent until `start` and after a failed one. */
interface Running {
  readonly orchestrator: Orchestrator;
  readonly router: FeedRouter;
  readonly store: InMemoryOrchestratorStore;
}

type Dispatched<O> = Awaited<
  ReturnType<typeof Orchestrator.prototype.run<unknown, O>>
>;

export class Engine {
  /** What agents inside sandboxes are doing, for a host that shows it. */
  readonly activities: HarnessActivities;
  readonly agents: AgentsManager;
  readonly artifacts: ArtifactsManager;
  /** Triggers agents create; they join the schedules a host declared. */
  readonly automations: AutomationService;
  /** What step bodies are built from: the managers, scoped per frame. */
  readonly bindings: Bindings;
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
  readonly workspaceId: string;
  readonly workspaces: WorkspacesManager;
  /** Where worktrees are cut; a host lets its sandboxes mount what is inside. */
  readonly worktrees: string;

  readonly #askable: boolean;
  readonly #publisher: FeedPublisher;
  readonly #print: (line: string) => void;
  readonly #registry = new Registry();
  readonly #scopes = new RunScopes();
  /**
   * Raw factories registered beside the definitions, by name, applied in
   * order at start. Each keeps its own factory's types by registering itself.
   */
  readonly #extra = new Map<string, (orchestrator: Orchestrator) => void>();
  readonly #held = new Map<string, HeldRun>();
  readonly #dispatching = new Set<Promise<unknown>>();
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
    this.workspaceId = workspaceId;
    this.worktrees = options.worktrees ?? Engine.worktreesFor(state);
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
      root,
      sessions,
      skills: skillResolver({ global: globalSkillsDir(home), workspace: root }),
      warn: (message) => print(`[agents] ${message}`),
    });
    this.artifacts = new ArtifactsManager({
      artifacts: options.artifacts,
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
      host: { catalogue, store: this.store },
      log: createLog((_level, message) => print(message)),
      root,
      sandboxes: (args) => this.sandboxes.scoped(args),
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
    this.#registry.monitor(record);
    this.#adopt(record.key);
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
    if (this.#extra.has(name)) {
      throw new Error(`register("${name}"): already registered`);
    }
    this.#extra.set(name, (orchestrator) =>
      orchestrator.register(name, factory)
    );
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
    contributeQueueConfig(config, { concurrency: 1, defaultName: "marbles" });
    // The store is built before the Orchestrator that registers definitions,
    // and a recovered run whose definition is gone would fail the start. So
    // only runs under a name that will be registered are recovered.
    const registered = (name: string) =>
      this.#registry.definitions.has(name) || this.#extra.has(name);
    const loaded =
      state === undefined
        ? undefined
        : loadRuns(state, print, {
            recover: (run) => askable && registered(run.step),
          });
    let orchestrator: Orchestrator | undefined;
    try {
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
      const recovered: {
        name: string;
        dispatched: Dispatched<unknown>;
        lock?: Lock;
      }[] = [];

      // A parked run is written as soon as it parks, so a crash or a quit while
      // it waits leaves a file the next process can adopt. It is written again
      // as soon as its answer is in, before the run goes on: a crash after that
      // finds a run that was mid-flight, which is skipped, not a stale question
      // that would be asked again over work already done.
      orchestrator.on("suspended", (payload) => {
        if (this.#held.has(payload.runId)) {
          this.#save(payload.runId);
        }
      });
      orchestrator.on("resumed", (payload) => {
        if (this.#held.has(payload.runId)) {
          this.#save(payload.runId);
        }
      });

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
      this.#running = { orchestrator, router, store };
      for (const { name, dispatched, lock } of recovered) {
        this.#track(name, dispatched, lock);
        this.#save(dispatched.id);
      }
      this.#phase = "started";
    } catch (error) {
      this.#phase = "failed";
      try {
        try {
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
        this.#held.clear();
        this.#running = undefined;
      }
      throw error;
    }
    return this;
  }

  #live(): Running {
    if (!this.#running) {
      throw new Error("the engine has not started");
    }
    return this.#running;
  }

  #extrasOf(runId: string): RunExtras | undefined {
    const scope = this.scopes.get(runId);
    return scope
      ? {
          ledger: scope.ledger.toJSON(),
          literals: Object.fromEntries(scope.literals),
          session: scope.session,
        }
      : undefined;
  }

  #save(runId: string, extras = this.#extrasOf(runId)): void {
    const held = this.#held.get(runId);
    if (this.state === undefined) {
      return;
    }
    try {
      saveRun(this.state, this.#live().store.snapshot(), runId, extras);
      if (held) {
        held.unsaved = false;
      }
    } catch (error) {
      this.#print(`[state] run ${runId} not saved: ${String(error)}`);
    }
  }

  /** Follow a run to its end: print its steps, route its posts, write it back. */
  #track<O>(name: string, dispatched: Dispatched<O>, lock?: Lock): Promise<O> {
    const { router } = this.#live();
    const held: HeldRun = {
      workflow: dispatched.workflow,
      ...(lock === undefined ? {} : { lock }),
      unsaved: true,
    };
    this.#held.set(dispatched.id, held);
    const routed = router.observe(name, dispatched.id);
    const observing = new AbortController();
    const observed = observeSteps(
      name,
      dispatched.workflow,
      this.#print,
      routed.onEvent,
      observing.signal
    );
    // The queue handle settles once its side effects are applied; the
    // workflow's own result carries the typed value.
    const complete = async () => {
      try {
        const [execution, observation] = await Promise.allSettled([
          dispatched.result().catch((error: unknown) => {
            observing.abort(error);
            throw error;
          }),
          observed,
        ]);
        await routed.settled();
        const settled = await dispatched.workflow.result();
        if (settled.status !== "complete") {
          await router.close(dispatched.id);
          throw new Error(
            settled.status === "failed"
              ? `run "${name}" failed: ${settled.error.message}`
              : `run "${name}" was cancelled: ${settled.reason ?? "no reason"}`
          );
        }
        if (execution.status === "rejected") {
          throw execution.reason;
        }
        if (observation.status === "rejected") {
          throw observation.reason;
        }
        return settled.value;
      } finally {
        const extras = this.#extrasOf(dispatched.id);
        try {
          await this.#scopes.settle(dispatched.id);
          this.#save(dispatched.id, extras);
        } finally {
          this.#held.delete(dispatched.id);
          release(held);
        }
      }
    };
    const result = complete();
    held.finalized = result;
    // The host may attach after the first snapshot refresh.
    result.catch(() => undefined);
    return result;
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

  /** Cancel one run, wherever it is. */
  async cancel(runId: string): Promise<void> {
    await this.#live().orchestrator.cancelRun(runId);
  }

  async launch<O>(
    name: string,
    input: unknown,
    triggerId?: string
  ): Promise<{ readonly id: string; readonly result: Promise<O> }> {
    const { orchestrator } = this.#live();
    if (this.#phase !== "started") {
      throw new Error(
        this.#phase === "stopping"
          ? "engine is stopping"
          : "engine has not finished starting"
      );
    }
    const dispatch = orchestrator.run<unknown, O>(name, input, {
      extensions: triggerId === undefined ? {} : { triggerId },
    });
    const tracking = dispatch.then((dispatched) => ({
      id: dispatched.id,
      result: this.#track(name, dispatched),
    }));
    this.#dispatching.add(tracking);
    try {
      return await tracking;
    } finally {
      this.#dispatching.delete(tracking);
    }
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
  async run<O>(name: string, input: unknown, triggerId?: string): Promise<O> {
    const launched = await this.launch<O>(name, input, triggerId);
    return launched.result;
  }

  /** Every Run this process dispatched or adopted. */
  runs(): Promise<readonly RunRecord[]> {
    return Promise.resolve(
      this.#live()
        .store.snapshot()
        .runs.map((record) => {
          const current = this.#held.get(record.id)?.workflow.state;
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
   * Settle and write what this process holds. `cancel` stops work that
   * cannot outlive the process: queued and running runs, and, without a
   * state dir, parked ones too. With a state dir a parked run keeps its
   * question and is adopted by the next process that can answer. Does
   * nothing on an engine that never started.
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
    { orchestrator, router }: Running,
    cancel: boolean
  ): Promise<void> {
    try {
      await this.interactions.close();
      // With a state dir a parked run is written and adopted by the next
      // process that can answer, so a quit keeps it and its open question.
      // Without one, nothing can resume it, so its entry says so.
      const parkedSurvive = this.state !== undefined;
      if (!parkedSurvive) {
        await router.cancelOpen();
      }
      await Promise.allSettled([...this.#dispatching]);
      if (cancel) {
        const doomed = parkedSurvive
          ? ["queued", "running"]
          : ["queued", "running", "suspended"];
        await Promise.all(
          [...this.#held]
            .filter(([, held]) => doomed.includes(held.workflow.state.status))
            .map(([runId]) => orchestrator.cancelRun(runId))
        );
      }
      await orchestrator.drain();
      await Promise.allSettled(
        [...this.#held]
          .filter(([, held]) =>
            TERMINAL_RUN_STATUSES.has(held.workflow.state.status)
          )
          .map(([, held]) => held.finalized)
      );
      for (const [runId, held] of this.#held) {
        if (held.unsaved) {
          this.#save(runId);
        }
      }
    } finally {
      try {
        await orchestrator.stop();
      } finally {
        for (const held of this.#held.values()) {
          release(held);
        }
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
    return this.#held.get(runId)?.workflow.root.subscribe(signal);
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

  async #dispose(): Promise<void> {
    try {
      await this.#starting?.catch(() => undefined);
      await this.stop({ cancel: true });
      for (const scope of this.#scopes) {
        await this.#scopes.settle(scope.id);
      }
      await this.interactions.close();
      await this.workspaces.close();
      await this.sandboxes.close().catch(() => undefined);
    } finally {
      await this.agents.close();
    }
  }
}
