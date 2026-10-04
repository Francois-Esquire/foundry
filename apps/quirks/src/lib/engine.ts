import { Config } from "@foundry/lib/config";
import type { ChannelMessage } from "@foundry/workflows/channels";
import { contributeQueueConfig } from "@foundry/workflows/config";
import type { BaseContext } from "@foundry/workflows/executable";
import type { Factory } from "@foundry/workflows/orchestrator";
import { Orchestrator } from "@foundry/workflows/orchestrator";
import type { RunRecord } from "@foundry/workflows/store";
import { InMemoryOrchestratorStore } from "@foundry/workflows/store";
import type { WorkflowState } from "@foundry/workflows/workflow";

import type { AutomationService } from "~/lib/automation/service";
import type { Bindings, Managers } from "~/lib/bindings";
import { bindManagers } from "~/lib/bindings";
import type { Catalog } from "~/lib/catalog";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { FeedPublisher } from "~/lib/feed/publish";
import type { FeedRouter } from "~/lib/feed/route";
import { feedRouter } from "~/lib/feed/route";
import type { Log } from "~/lib/log";
import { createLog } from "~/lib/log";
import type { AgentsManager } from "~/lib/managers/agents";
import type { ArtifactsManager } from "~/lib/managers/artifacts";
import type { SandboxesManager } from "~/lib/managers/sandboxes";
import type { WorkspacesManager } from "~/lib/managers/workspaces";
import { observeSteps } from "~/lib/observe";
import { PAUSE_KIND, restoreScope, runs as runScopes } from "~/lib/run-scope";
import type { HarnessActivities } from "~/lib/sandbox/activities";
import type { HarnessInteractions } from "~/lib/sandbox/interactions";
import type { Lock } from "~/lib/state/locks";
import type { RunExtras } from "~/lib/state/runs";
import { loadRuns, saveRun } from "~/lib/state/runs";
import { factoryFor } from "~/lib/tree";
import type { Schedule } from "~/lib/triggers";

/**
 * The engine: the managers, the catalog, and a real Orchestrator over the
 * in-memory store, held together. Everything it uses is built outside and
 * handed to the constructor already instanced, so a host decides what each
 * one is; `createEngine` is the assembly Quirks itself uses.
 *
 * Every workflow is dispatched as a Run through the queue, so Runs, Jobs and
 * frames all exist and be inspectable. Given a state dir, the store hydrates
 * from `runs/*.json` at start and each Run is written back when it parks and
 * once it settles; without one, nothing survives the process. A Run parked
 * on a question is adopted by the next process that can answer it: the
 * Orchestrator re-parks it, its scope gets the ledger it recorded, and its
 * question stays open on the feed.
 */

export interface EngineOptions extends Managers {
  /** What agents inside sandboxes are doing, for a host that shows it. */
  readonly activities?: HarnessActivities;
  /**
   * Whether someone can answer `ask` in this process (the dashboard).
   * Otherwise a question cancels its run rather than pausing it forever, and
   * parked runs from earlier processes are left for a process that can.
   */
  readonly askable?: boolean;
  /** Triggers agents create; when given, its schedules are the live set. */
  readonly automations?: AutomationService;
  /** What can be launched: the definitions, schedules, and monitors a host registered. */
  readonly catalog: Catalog;
  /** Writes entries steps post; without one, posts are dropped. */
  readonly feed?: FeedPublisher;
  /** Harness ids the agents manager can route to, in preference order. */
  readonly harnesses?: readonly string[];
  readonly interactions?: HarnessInteractions;
  /** Host output for a body's `log(...)`; defaults to `print`. */
  readonly log?: Log;
  /** One line of engine status at a time; dropped when omitted. */
  readonly print?: (line: string) => void;
  /** The workspace root: the config's directory. */
  readonly root: string;
  /** Workspace state dir. Omit for in-memory, which `--dry` always is. */
  readonly state?: string;
}

/** What a started engine holds; absent until `start` and after a failed one. */
interface Running {
  readonly orchestrator: Orchestrator;
  readonly router: FeedRouter | undefined;
  readonly store: InMemoryOrchestratorStore;
}

type Dispatched<O> = Awaited<
  ReturnType<typeof Orchestrator.prototype.run<unknown, O>>
>;

export class Engine {
  readonly activities: HarnessActivities | undefined;
  readonly agents: AgentsManager | undefined;
  readonly artifacts: ArtifactsManager | undefined;
  readonly automations: AutomationService | undefined;
  /** What step bodies are built from: the managers above, scoped per frame. */
  readonly bindings: Bindings;
  readonly catalog: Catalog;
  /** Harness ids available to agents, in preference order. */
  readonly harnesses: readonly string[];
  readonly interactions: HarnessInteractions | undefined;
  readonly root: string;
  readonly sandboxes: SandboxesManager | undefined;
  readonly state: string | undefined;
  readonly workspaces: WorkspacesManager | undefined;

  readonly #askable: boolean;
  readonly #feed: FeedPublisher | undefined;
  readonly #print: (line: string) => void;
  /** Registrations made beside the catalog, applied in order at start. */
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
    const print = options.print ?? (() => undefined);
    this.activities = options.activities;
    this.agents = options.agents;
    this.artifacts = options.artifacts;
    this.automations = options.automations;
    this.catalog = options.catalog;
    this.harnesses = options.harnesses ?? [];
    this.interactions = options.interactions;
    this.root = options.root;
    this.sandboxes = options.sandboxes;
    this.state = options.state;
    this.workspaces = options.workspaces;
    this.#askable = options.askable ?? false;
    this.#feed = options.feed;
    this.#print = print;
    this.bindings = bindManagers({
      agents: options.agents,
      artifacts: options.artifacts,
      log: options.log ?? createLog((_level, message) => print(message)),
      root: options.root,
      sandboxes: options.sandboxes,
      state: options.state,
      workspaces: options.workspaces,
    });
  }

  /**
   * Register a raw workflows factory beside the catalog, for a host step
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

  /** Every named definition in the catalog, then what the host registered beside it. */
  #registerAll(orchestrator: Orchestrator): void {
    for (const definition of this.catalog.definitions.values()) {
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
    const feed = this.#feed;
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
    const router = feed
      ? feedRouter({ askable, feed, orchestrator, print })
      : undefined;
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
      await router?.adopt(record.step, runId);
    }
    await this.interactions?.restore();
    // A crashed dashboard never cancelled its open questions; nothing can answer them now.
    await feed
      ?.cancelAbandoned()
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
    const routed = router?.observe(name, dispatched.id);
    const observed = observeSteps(
      name,
      dispatched.workflow,
      this.#print,
      routed?.onEvent
    );
    // The queue handle settles once its side effects are applied; the
    // workflow's own result carries the typed value.
    const complete = async () => {
      await dispatched.result();
      const settled = await dispatched.workflow.result();
      await observed;
      await routed?.settled();
      // A run that ends without its answer (cancelled, or failed by a
      // sibling) takes its question with it: the entry follows the run.
      if (settled.status !== "complete") {
        await router?.close(dispatched.id);
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
    if (await this.interactions?.answer(entryId, answer)) {
      return;
    }
    const { router } = this.#live();
    if (!router) {
      return Promise.reject(new Error("The feed is not available."));
    }
    return router.answer(entryId, answer);
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
   * `unknown` because names, not types, address the catalog — the caller
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

  /** The live triggers: what the catalog declares, plus what agents created. */
  schedules(): readonly Schedule[] {
    return (
      this.automations?.schedules() ?? [...this.catalog.schedules.values()]
    );
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
    await this.interactions?.close();
    // With a state dir a parked run is written and adopted by the next
    // process that can answer, so a quit keeps it and its open question.
    // Without one, nothing can resume it, so its entry says so.
    const parkedSurvive = this.state !== undefined;
    if (!parkedSurvive) {
      await router?.cancelOpen();
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
   * Close the managers this engine was given, after `stop`. The models go
   * last and always: a provider may hold a child process.
   */
  async dispose(): Promise<void> {
    try {
      await this.interactions?.close();
      await this.workspaces?.close();
      await this.sandboxes?.close().catch(() => undefined);
    } finally {
      await this.agents?.close();
    }
  }
}
