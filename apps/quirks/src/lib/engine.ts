import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "@foundry/agents/authorization";
import type { SessionStore } from "@foundry/agents/session";
import type { Artifacts as ArtifactStore } from "@foundry/artifacts";
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
import type { WorkflowState } from "@foundry/workflows/workflow";

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
import type { MonitorSpec } from "~/lib/monitor";
import { observeSteps } from "~/lib/observe";
import type { DefinitionEntry } from "~/lib/registry";
import { Registry } from "~/lib/registry";
import { PAUSE_KIND, restoreScope, runs as runScopes } from "~/lib/run-scope";
import { HarnessActivities } from "~/lib/sandbox/activities";
import { JsonAgentGrantRepository } from "~/lib/sandbox/grants";
import { HarnessInteractions } from "~/lib/sandbox/interactions";
import type { Lock } from "~/lib/state/locks";
import type { RunExtras } from "~/lib/state/runs";
import { loadRuns, saveRun } from "~/lib/state/runs";
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
  readonly artifacts: ArtifactStore;
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
   * How git runs on the root workspace. Give what the `git()` layer of
   * `workspaces` was built with when that is not the default.
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
  /** Identity of this workspace: part of a declared artifact's id and of every feed entry. */
  readonly workspaceId: string;
  /** Directories and repositories, with the `directory` and `git` layers. */
  readonly workspaces: Catalogue;
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
  readonly sessions: SessionStore;
  readonly state: string | undefined;
  readonly workspaceId: string;
  readonly workspaces: WorkspacesManager;
  /** Where worktrees are cut; a host lets its sandboxes mount what is inside. */
  readonly worktrees: string;

  readonly #askable: boolean;
  readonly #publisher: FeedPublisher;
  readonly #print: (line: string) => void;
  readonly #registry = new Registry();
  /** Raw factories registered beside the definitions, applied in order at start. */
  readonly #extra: ((orchestrator: Orchestrator) => void)[] = [];
  // Runs this process dispatched or adopted and has not written since they
  // last changed. Persisting is not the run: a failed write warns and the
  // value still returns.
  readonly #unsaved = new Set<string>();
  readonly #active = new Map<string, () => WorkflowState>();
  readonly #subscribers = new Map<
    string,
    (signal?: AbortSignal) => ReadableStream<ChannelMessage>
  >();
  readonly #dispatching = new Set<Promise<unknown>>();
  // Ownership of adopted runs; released once a run settles or the process stops.
  readonly #locks = new Map<string, Lock>();
  #running: Running | undefined;
  #phase: "new" | "started" | "stopping" = "new";

  constructor(options: EngineOptions) {
    const { models, root, sessions, state, workspaceId } = options;
    const print = options.print ?? (() => undefined);
    const home = options.home ?? homedir();
    const askable = options.askable ?? false;
    const { containers } = options;
    this.models = models;
    this.root = root;
    this.sessions = sessions;
    this.state = state;
    this.workspaceId = workspaceId;
    this.worktrees = join(state ?? join(tmpdir(), "quirks"), "worktrees");
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
      state,
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
    this.agents = new AgentsManager({
      activities: this.activities,
      automations: this.automations,
      defaultExecutor: () => selectExecutor(models),
      dry: options.dry ?? false,
      interactions: this.interactions,
      models,
      sessions,
      skills: skillResolver({ global: globalSkillsDir(home), workspace: root }),
      warn: (message) => print(`[agents] ${message}`),
    });
    this.artifacts = new ArtifactsManager({
      artifacts: options.artifacts,
      workspaceId,
    });
    this.sandboxes = new SandboxesManager({
      containers:
        typeof containers === "function"
          ? containers
          : () => Promise.resolve(containers),
      home,
      root,
    });
    this.workspaces = new WorkspacesManager({
      catalogue: options.workspaces,
      gitOptions: options.git ?? {},
      root,
      worktreeHome: this.worktrees,
    });
    this.bindings = {
      agents: (args) => this.agents.scoped(args),
      artifacts: (args) => this.artifacts.scoped(args),
      host: { catalogue: options.workspaces, state },
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
      this.#running?.orchestrator.register(
        definition.name,
        factoryFor(definition, () => this.bindings)
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

  /** Watch a source on a cadence; its detector step is defined under `key`. */
  monitor(key: string, spec: MonitorSpec, record: Schedule): void {
    if (!this.#registry.definitions.has(key)) {
      throw new Error(`monitor "${key}": define its detector step first`);
    }
    this.#registry.monitor(key, spec, record);
  }

  /** What each monitor watches, by key. */
  monitors(): ReadonlyMap<string, MonitorSpec> {
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
    this.#extra.push((orchestrator) => orchestrator.register(name, factory));
  }

  /** Every named definition, then what the host registered beside them. */
  #registerAll(orchestrator: Orchestrator): void {
    for (const definition of this.#registry.definitions.values()) {
      orchestrator.register(
        definition.name as string,
        factoryFor(definition, () => this.bindings)
      );
    }
    for (const register of this.#extra) {
      register(orchestrator);
    }
  }

  /** Build the Orchestrator, register what can run, and adopt what an earlier process parked. */
  async start(): Promise<this> {
    if (this.#phase !== "new") {
      throw new Error("the engine has already started");
    }
    this.#phase = "started";
    const { state } = this;
    const askable = this.#askable;
    const feed = this.#publisher;
    const print = this.#print;
    const config = new Config();
    contributeQueueConfig(config, { concurrency: 1, defaultName: "quirks" });
    // The store is built before the Orchestrator that registers definitions,
    // and a recovered run whose definition is gone would fail the start. So
    // the names are collected first; registering only ever registers.
    const registered = new Set<string>();
    this.#registerAll({
      register: (name: string) => registered.add(name),
    } as unknown as Orchestrator);
    const loaded =
      state === undefined
        ? undefined
        : loadRuns(state, print, {
            recover: (run) => askable && registered.has(run.step),
          });
    for (const [runId, extras] of loaded?.recovered ?? []) {
      restoreScope(runId, extras);
    }
    const store = new InMemoryOrchestratorStore(
      loaded === undefined ? {} : { snapshot: loaded.snapshot }
    );

    const orchestrator = new Orchestrator({ config, store });
    await orchestrator.setup();
    this.#registerAll(orchestrator);
    await orchestrator.start();
    const router = feedRouter({ askable, feed, orchestrator, print });
    this.#running = { orchestrator, router, store };

    // A parked run is written as soon as it parks, so a crash or a quit while
    // it waits leaves a file the next process can adopt. It is written again
    // as soon as its answer is in, before the run goes on: a crash after that
    // finds a run that was mid-flight, which is skipped, not a stale question
    // that would be asked again over work already done.
    const held = (runId: string) =>
      this.#unsaved.has(runId) || this.#active.has(runId);
    orchestrator.on("suspended", (payload) => {
      if (held(payload.runId)) {
        this.#save(payload.runId);
      }
    });
    orchestrator.on("resumed", (payload) => {
      if (held(payload.runId)) {
        this.#save(payload.runId);
      }
    });
    for (const [runId, lock] of loaded?.locks ?? []) {
      this.#locks.set(runId, lock);
    }

    // Adopt what the store recovered: follow each parked run and keep its
    // question open under this process before abandoned entries are swept.
    for (const runId of loaded?.recovered.keys() ?? []) {
      const dispatched = await orchestrator.get(runId);
      const record = store.snapshot().runs.find((run) => run.id === runId);
      if (!(dispatched && record)) {
        continue;
      }
      print(`[run] ${record.step} recovered ${runId}`);
      this.#track(record.step, dispatched);
      // The file now names this process as the owner.
      this.#save(runId);
      await router.adopt(record.step, runId);
    }
    await this.interactions.restore();
    // A crashed dashboard never cancelled its open questions; nothing can answer them now.
    await feed
      .cancelAbandoned()
      .catch((error: unknown) => print(`[feed] ${String(error)}`));
    return this;
  }

  #live(): Running {
    if (!this.#running) {
      throw new Error("the engine has not started");
    }
    return this.#running;
  }

  #extrasOf(runId: string): RunExtras | undefined {
    const scope = runScopes.get(runId);
    return scope
      ? {
          ledger: scope.ledger.toJSON(),
          literals: Object.fromEntries(scope.literals),
          session: scope.session,
        }
      : undefined;
  }

  #save(runId: string, extras = this.#extrasOf(runId)): void {
    this.#unsaved.delete(runId);
    if (this.state === undefined) {
      return;
    }
    try {
      saveRun(this.state, this.#live().store.snapshot(), runId, extras);
    } catch (error) {
      this.#print(`[state] run ${runId} not saved: ${String(error)}`);
    }
  }

  #release(runId: string): void {
    this.#locks.get(runId)?.release();
    this.#locks.delete(runId);
  }

  /** Follow a run to its end: print its steps, route its posts, write it back. */
  #track<O>(name: string, dispatched: Dispatched<O>): Promise<O> {
    const { router } = this.#live();
    this.#active.set(dispatched.id, () => dispatched.workflow.state);
    this.#subscribers.set(dispatched.id, (signal) =>
      dispatched.workflow.root.subscribe(signal)
    );
    this.#unsaved.add(dispatched.id);
    const routed = router.observe(name, dispatched.id);
    const observed = observeSteps(
      name,
      dispatched.workflow,
      this.#print,
      routed.onEvent
    );
    // The queue handle settles once its side effects are applied; the
    // workflow's own result carries the typed value.
    const complete = async () => {
      await dispatched.result();
      const settled = await dispatched.workflow.result();
      await observed;
      await routed.settled();
      // A run that ends without its answer (cancelled, or failed by a
      // sibling) takes its question with it: the entry follows the run.
      if (settled.status !== "complete") {
        await router.close(dispatched.id);
      }
      // Close what the run opened through the context; its ledger is read
      // first, since settling forgets the scope.
      const extras = this.#extrasOf(dispatched.id);
      await runScopes.get(dispatched.id)?.settle();
      this.#active.delete(dispatched.id);
      this.#subscribers.delete(dispatched.id);
      this.#save(dispatched.id, extras);
      this.#release(dispatched.id);
      if (settled.status !== "complete") {
        throw new Error(
          settled.status === "failed"
            ? `run "${name}" failed: ${settled.error.message}`
            : `run "${name}" was cancelled: ${settled.reason ?? "no reason"}`
        );
      }
      return settled.value;
    };
    const result = complete();
    // The host may attach after the first snapshot refresh.
    result.catch(() => undefined);
    return result;
  }

  #scopeOf(runId: string) {
    const scope = runScopes.get(runId);
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
    if (this.#phase === "stopping") {
      throw new Error("engine is stopping");
    }
    const dispatch = orchestrator.run<unknown, O>(name, input, {
      extensions: triggerId === undefined ? {} : { triggerId },
    });
    this.#dispatching.add(dispatch);
    const dispatched = await dispatch.finally(() =>
      this.#dispatching.delete(dispatch)
    );
    return { id: dispatched.id, result: this.#track(name, dispatched) };
  }

  /**
   * Park a running step: what it opened stops and the run shows as
   * suspended. `false` when no such step is running here.
   */
  pause(runId: string, stepId: string, reason?: string): boolean {
    return runScopes.get(runId)?.pause(stepId, reason) ?? false;
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
          const current = this.#active.get(record.id)?.();
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
  async stop(options?: { readonly cancel?: boolean }): Promise<void> {
    if (!this.#running) {
      return;
    }
    const { orchestrator, router, store } = this.#running;
    this.#phase = "stopping";
    await this.interactions.close();
    // With a state dir a parked run is written and adopted by the next
    // process that can answer, so a quit keeps it and its open question.
    // Without one, nothing can resume it, so its entry says so.
    const parkedSurvive = this.state !== undefined;
    if (!parkedSurvive) {
      await router.cancelOpen();
    }
    await Promise.allSettled([...this.#dispatching]);
    if (options?.cancel) {
      const doomed = parkedSurvive
        ? ["queued", "running"]
        : ["queued", "running", "suspended"];
      await Promise.all(
        store
          .snapshot()
          .runs.filter((run) => doomed.includes(run.status))
          .map((run) => orchestrator.cancelRun(run.id))
      );
    }
    await orchestrator.drain();
    for (const runId of [...this.#unsaved]) {
      this.#save(runId);
    }
    await orchestrator.stop();
    for (const runId of [...this.#locks.keys()]) {
      this.#release(runId);
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
    return this.#subscribers.get(runId)?.(signal);
  }

  /**
   * Close what this engine was handed, after `stop`: the workspace system,
   * the containers if a sandbox ever opened them, and the models. The models
   * go last and always: a provider may hold a child process.
   */
  async dispose(): Promise<void> {
    try {
      await this.interactions.close();
      await this.workspaces.close();
      await this.sandboxes.close().catch(() => undefined);
    } finally {
      await this.agents.close();
    }
  }
}
