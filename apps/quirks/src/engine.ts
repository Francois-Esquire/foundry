import { Config } from "@foundry/lib/config";
import type { ChannelMessage } from "@foundry/workflows/channels";
import { contributeQueueConfig } from "@foundry/workflows/config";
import type { Orchestrator as OrchestratorType } from "@foundry/workflows/orchestrator";
import { Orchestrator } from "@foundry/workflows/orchestrator";
import type { RunRecord } from "@foundry/workflows/store";
import { InMemoryOrchestratorStore } from "@foundry/workflows/store";
import type { WorkflowState } from "@foundry/workflows/workflow";

import type { FeedAnswer } from "~/feed/entry";
import type { FeedPublisher } from "~/feed/publish";
import { feedRouter } from "~/feed/route";
import { PAUSE_KIND, restoreScope, runs as runScopes } from "~/lib/run-scope";
import { observeSteps } from "~/observe";
import type { RunExtras } from "~/state/runs";
import { loadRuns, saveRun } from "~/state/runs";

/**
 * The execution engine: a real Orchestrator over the in-memory store.
 *
 * Every workflow is dispatched as a Run through the queue, so Runs, Jobs and
 * frames all exist and be inspectable. Given a state dir, the store hydrates
 * from `runs/*.json` at start and each Run is written back when it parks and
 * once it settles; without one, nothing survives the process. A Run parked
 * on a question is adopted by the next process that can answer it: the
 * Orchestrator re-parks it, its scope gets the ledger it recorded, and its
 * question stays open on the feed.
 */

export interface Engine {
  /** Answer an open input entry; the run that asked resumes with it. */
  answer(entryId: string, answer: FeedAnswer): Promise<void>;
  /** Cancel one run, wherever it is. */
  cancel(runId: string): Promise<void>;
  launch<O>(
    name: string,
    input: unknown,
    triggerId?: string
  ): Promise<{ readonly id: string; readonly result: Promise<O> }>;
  /**
   * Park a running step: what it opened stops and the run shows as
   * suspended. `false` when no such step is running here.
   */
  pause(runId: string, stepId: string, reason?: string): boolean;
  /**
   * Resume a paused step. The body replays from the top; a prompt goes to
   * the first turn of the agent session it had open.
   */
  resume(runId: string, stepId: string, prompt?: string): Promise<void>;
  /**
   * Dispatch a registered definition and wait for its value. `input` is
   * `unknown` because names, not types, address the registry — the caller
   * states the output type it expects.
   */
  run<O>(name: string, input: unknown, triggerId?: string): Promise<O>;
  /** Every Run this process dispatched or adopted. */
  runs(): Promise<readonly RunRecord[]>;
  /** Hand a prompt to the agent turn running in a step; it becomes the next message. */
  steer(runId: string, stepId: string, prompt: string): void;
  /**
   * Settle and write what this process holds. `cancel` stops work that
   * cannot outlive the process: queued and running runs, and, without a
   * state dir, parked ones too. With a state dir a parked run keeps its
   * question and is adopted by the next process that can answer.
   */
  stop(options?: { readonly cancel?: boolean }): Promise<void>;
  /**
   * A live run's events and chunks from its start, then as they happen;
   * `undefined` once the run is no longer held by this process.
   */
  stream(
    runId: string,
    signal?: AbortSignal
  ): ReadableStream<ChannelMessage> | undefined;
}

/**
 * Definitions register through a callback rather than a map: `register` is
 * generic per definition, and a map would collapse every factory to the same
 * `Factory<unknown, unknown>` and lose the input type at the call site.
 */
export type RegisterDefinitions = (orchestrator: OrchestratorType) => void;

export interface EngineOptions {
  /**
   * Whether someone can answer `ask` in this process (the dashboard).
   * Otherwise a question cancels its run rather than pausing it forever, and
   * parked runs from earlier processes are left for a process that can.
   */
  readonly askable?: boolean;
  /** Writes entries steps post; without one, posts are dropped. */
  readonly feed?: FeedPublisher;
  readonly print: (line: string) => void;
  /** Workspace state dir. Omit for in-memory, which `--dry` always is. */
  readonly state?: string;
}

export async function startEngine(
  register: RegisterDefinitions,
  { askable = false, feed, print, state }: EngineOptions
): Promise<Engine> {
  const config = new Config();
  contributeQueueConfig(config, { concurrency: 1, defaultName: "quirks" });
  // The store is built before the Orchestrator that registers definitions,
  // and a recovered run whose definition is gone would fail the start. So
  // the names are collected first; the callback only ever registers.
  const registered = new Set<string>();
  register({
    register: (name: string) => registered.add(name),
  } as unknown as OrchestratorType);
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
  register(orchestrator);
  await orchestrator.start();
  const router = feed
    ? feedRouter({ askable, feed, orchestrator, print })
    : undefined;

  // Runs this process dispatched or adopted and has not written since they
  // last changed. Persisting is not the run: a failed write warns and the
  // value still returns.
  const unsaved = new Set<string>();
  const active = new Map<string, () => WorkflowState>();
  const subscribers = new Map<
    string,
    (signal?: AbortSignal) => ReadableStream<ChannelMessage>
  >();
  const dispatching = new Set<Promise<unknown>>();
  let stopping = false;
  const extrasOf = (runId: string): RunExtras | undefined => {
    const scope = runScopes.get(runId);
    return scope
      ? { ledger: scope.ledger.toJSON(), session: scope.session }
      : undefined;
  };
  const save = (runId: string, extras = extrasOf(runId)) => {
    unsaved.delete(runId);
    if (state === undefined) {
      return;
    }
    try {
      saveRun(state, store.snapshot(), runId, extras);
    } catch (error) {
      print(`[state] run ${runId} not saved: ${String(error)}`);
    }
  };
  // A parked run is written as soon as it parks, so a crash or a quit while
  // it waits leaves a file the next process can adopt. It is written again
  // as soon as its answer is in, before the run goes on: a crash after that
  // finds a run that was mid-flight, which is skipped, not a stale question
  // that would be asked again over work already done.
  const held = (runId: string) => unsaved.has(runId) || active.has(runId);
  orchestrator.on("suspended", (payload) => {
    if (held(payload.runId)) {
      save(payload.runId);
    }
  });
  orchestrator.on("resumed", (payload) => {
    if (held(payload.runId)) {
      save(payload.runId);
    }
  });
  // Ownership of adopted runs; released once a run settles or the process stops.
  const locks = new Map(loaded?.locks ?? []);
  const release = (runId: string) => {
    locks.get(runId)?.release();
    locks.delete(runId);
  };

  /** Follow a run to its end: print its steps, route its posts, write it back. */
  const track = <O>(
    name: string,
    dispatched: Awaited<ReturnType<typeof orchestrator.run<unknown, O>>>
  ): Promise<O> => {
    active.set(dispatched.id, () => dispatched.workflow.state);
    subscribers.set(dispatched.id, (signal) =>
      dispatched.workflow.root.subscribe(signal)
    );
    unsaved.add(dispatched.id);
    const routed = router?.observe(name, dispatched.id);
    const observed = observeSteps(
      name,
      dispatched.workflow,
      print,
      routed?.onEvent
    );
    // The queue handle settles once its side effects are applied; the
    // workflow's own result carries the typed value.
    const complete = async () => {
      await dispatched.result();
      const settled = await dispatched.workflow.result();
      await observed;
      await routed?.settled();
      // Close what the run opened through the context; its ledger is read
      // first, since settling forgets the scope.
      const extras = extrasOf(dispatched.id);
      await runScopes.get(dispatched.id)?.settle();
      active.delete(dispatched.id);
      subscribers.delete(dispatched.id);
      save(dispatched.id, extras);
      release(dispatched.id);
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
  };

  // Adopt what the store recovered: follow each parked run and keep its
  // question open under this process before abandoned entries are swept.
  for (const runId of loaded?.recovered.keys() ?? []) {
    const dispatched = await orchestrator.get(runId);
    const record = store.snapshot().runs.find((run) => run.id === runId);
    if (!(dispatched && record)) {
      continue;
    }
    print(`[run] ${record.step} recovered ${runId}`);
    track(record.step, dispatched);
    // The file now names this process as the owner.
    save(runId);
    await router?.adopt(record.step, runId);
  }
  // A crashed dashboard never cancelled its open questions; nothing can answer them now.
  await feed
    ?.cancelAbandoned()
    .catch((error: unknown) => print(`[feed] ${String(error)}`));

  const scopeOf = (runId: string) => {
    const scope = runScopes.get(runId);
    if (!scope) {
      throw new Error(`run ${runId} is not running here`);
    }
    return scope;
  };

  const engine: Engine = {
    answer(entryId, answer) {
      if (!router) {
        return Promise.reject(new Error("The feed is not available."));
      }
      return router.answer(entryId, answer);
    },
    async cancel(runId) {
      await orchestrator.cancelRun(runId);
    },
    async launch<O>(name: string, input: unknown, triggerId?: string) {
      if (stopping) {
        throw new Error("engine is stopping");
      }
      const dispatch = orchestrator.run<unknown, O>(name, input, {
        extensions: triggerId === undefined ? {} : { triggerId },
      });
      dispatching.add(dispatch);
      const dispatched = await dispatch.finally(() =>
        dispatching.delete(dispatch)
      );
      return { id: dispatched.id, result: track(name, dispatched) };
    },
    pause(runId, stepId, reason) {
      return runScopes.get(runId)?.pause(stepId, reason) ?? false;
    },
    async resume(runId, stepId, prompt) {
      const scope = scopeOf(runId);
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
    },
    async run<O>(name: string, input: unknown, triggerId?: string): Promise<O> {
      const launched = await this.launch<O>(name, input, triggerId);
      return launched.result;
    },

    async runs() {
      return store.snapshot().runs.map((record) => {
        const current = active.get(record.id)?.();
        return current
          ? {
              ...record,
              metadata: { ...record.metadata, workflow: current },
              snapshot: current.tree ?? record.snapshot,
            }
          : record;
      });
    },
    steer(runId, stepId, prompt) {
      scopeOf(runId).steer(stepId, prompt);
    },

    async stop(options) {
      stopping = true;
      // With a state dir a parked run is written and adopted by the next
      // process that can answer, so a quit keeps it and its open question.
      // Without one, nothing can resume it, so its entry says so.
      const parkedSurvive = state !== undefined;
      if (!parkedSurvive) {
        await router?.cancelOpen();
      }
      await Promise.allSettled([...dispatching]);
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
      for (const runId of [...unsaved]) {
        save(runId);
      }
      await orchestrator.stop();
      for (const runId of [...locks.keys()]) {
        release(runId);
      }
    },

    stream(runId, signal) {
      return subscribers.get(runId)?.(signal);
    },
  };
  return engine;
}
