import { randomUUID } from "node:crypto";
import { processAlive } from "@foundry/lib/file-lock";
import type { JsonValue } from "@foundry/lib/json";

import type { ExecutionStatus } from "~/lib/execution-statuses";
import {
  EXECUTION_STATUSES,
  SETTLED_EXECUTION_STATUSES,
} from "~/lib/execution-statuses";
import { isRecord } from "~/lib/state/json";
import type { StateStore } from "~/lib/state/store";

/**
 * Execution Runs: every run the engine admits, a workflow definition or a
 * host task, from the moment it is queued until it settles. Each has one
 * durable record in the state store's `executions` collection, written when
 * it is queued, again before its first effect when it starts, and at each
 * progress and settlement after that, so a host reads one lifecycle record
 * per run and never keeps its own. While it runs, each observation is
 * appended to the run's log in `observations`, so recording one costs the
 * same however many came before; the settled record carries them all and
 * the log goes.
 *
 * Runs wait in named FIFO queues. A queue has a concurrency, the runs it lets
 * in at once, and no length limit: a run is never refused for capacity, it
 * waits its turn. Queues admit independently, so a backlog in one never
 * holds up another. Concurrency changes live; lowering it never stops what
 * already runs, it only holds back the next admission. A run that parks on a
 * question or releases its slot (a long-lived Program) leaves room behind it;
 * a parked run that resumes takes its slot back without waiting, as work
 * already admitted.
 *
 * Records name the process that owns them. On start, an engine recovers only
 * the records of a process that has exited: running work becomes
 * `interrupted`, never replayed, and queued work, which has had no effect
 * yet, goes back on its queue in its original order when the host asks for
 * that. Records of a live process, this one included, are left alone.
 *
 * A host prunes settled runs it no longer needs to keep. Pruning never
 * touches an unsettled run, and it says what it removed: each scope the host
 * names keeps a durable gap, written before the records go, so a reader can
 * tell missing history from none.
 */

/** The queue a run joins when neither the launch nor its task names one. */
export const DEFAULT_QUEUE = "marbles";
/** The concurrency of a queue nothing configured. */
const DEFAULT_CONCURRENCY = 1;

const STATUSES: ReadonlySet<string> = new Set(EXECUTION_STATUSES);

/**
 * Token counts a provider reported for a model turn. A count is present only
 * when every model call in the turn reported it; otherwise it is unknown and
 * absent, never zero.
 */
export interface ExecutionUsage {
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  /** Who measured it: the provider's own response. */
  readonly source: "provider";
  readonly totalTokens?: number;
}

export type ObservationStatus =
  | "running"
  | "complete"
  | "failed"
  /** A tool call the agent's authority refused. */
  | "denied"
  | "cancelled";

interface ObservationBase {
  readonly endedAt?: string;
  /** A short, safe classification of a failure, such as an error's name; never its message. */
  readonly errorCode?: string;
  /** Unique within its run; recording the same id again replaces it. */
  readonly id: string;
  readonly startedAt: string;
  readonly status: ObservationStatus;
}

/** One `stream` or `generate` call on an agent session; it may span several model requests. */
export interface ModelTurnObservation extends ObservationBase {
  readonly kind: "model-turn";
  readonly model: string;
  readonly provider?: string;
  readonly sessionId: string;
  readonly usage?: ExecutionUsage;
}

/** A tool an agent called: its name and outcome, never its arguments or result. */
export interface ToolCallObservation extends ObservationBase {
  readonly kind: "tool-call";
  readonly name: string;
  readonly sessionId: string;
}

/** What a host task did (`effect`) or produced (`result`), in the host's own `type` and data. */
export interface HostObservation extends ObservationBase {
  readonly data?: JsonValue;
  readonly kind: "effect" | "result";
  readonly type: string;
}

export type ExecutionObservation =
  | ModelTurnObservation
  | ToolCallObservation
  | HostObservation;

/** A run's durable record. A new object, with a higher `revision`, at each change. */
export interface ExecutionRun {
  /** Host identifiers the run belongs to, such as `moduleId` or `agentSessionId`. */
  readonly correlation: Readonly<Record<string, string>>;
  /** Why it failed or was interrupted. */
  readonly error?: { readonly code: string; readonly message?: string };
  /** `rn-*`; a workflow run has the same id in the Orchestrator and the feed. */
  readonly id: string;
  /** Kept only while queued, to admit the run again after a restart. */
  readonly input?: JsonValue;
  /** A workflow definition run through the Orchestrator, or a host task. */
  readonly kind: "workflow" | "task";
  /** The definition or task name it was launched by. */
  readonly name: string;
  readonly observations: readonly ExecutionObservation[];
  /** The process that owns it while it is unsettled. */
  readonly owner: { readonly pid: number };
  /** The latest progress it reported. */
  readonly progress?: JsonValue;
  readonly queue: string;
  /** Increases with every change; a subscriber keeps the highest it has seen. */
  readonly revision: number;
  /** Admission order: increasing across launches, and kept across restarts. */
  readonly sequence: number;
  /** The caller's identity for the request; launching its name with it again returns this run. */
  readonly source?: string;
  readonly status: ExecutionStatus;
  readonly timestamps: {
    readonly queuedAt: string;
    readonly settledAt?: string;
    readonly startedAt?: string;
    readonly updatedAt: string;
  };
}

export interface QueueSettings {
  /** Runs admitted at once: a positive integer, or `Infinity`. */
  readonly concurrency: number;
}

export interface QueueState extends QueueSettings {
  /** Runs holding a slot now. */
  readonly active: number;
  readonly name: string;
  /** Runs waiting their turn. */
  readonly waiting: number;
}

/**
 * What pruning removed from one host scope, such as a Module: a count and
 * the latest settlement among the removed runs. Runs of the scope that
 * settled up to `through` may be missing; later ones are all retained.
 */
export interface RetentionGap {
  /** Runs removed from this scope so far. */
  readonly removed: number;
  readonly scope: string;
  /** The latest `settledAt` of a removed run. */
  readonly through: string;
  /** When pruning last removed a run of this scope. */
  readonly updatedAt: string;
}

/** Retained runs at the moment of subscribing, and how to stop listening. */
export interface ExecutionSubscription {
  readonly snapshot: readonly ExecutionRun[];
  unsubscribe(): void;
}

/**
 * What a host reads and steers: the retained runs, their lifecycle as it
 * happens, and the queues. Changes made by another process sharing the store
 * are not announced; a fresh subscription in this process sees what it wrote.
 */
export interface ExecutionRuns {
  /** Set a queue's concurrency, now; it is created if it does not exist. */
  configure(queue: string, settings: QueueSettings): void;
  /** What pruning has removed, by scope. */
  gaps(): readonly RetentionGap[];
  get(id: string): ExecutionRun | undefined;
  /** Every retained run, in admission order. */
  list(): readonly ExecutionRun[];
  /**
   * Remove settled runs for good, recording each one's scope in its gap
   * first. Ids of unknown or unsettled runs are skipped. Returns the runs
   * removed; subscribers are not told (the caller knows).
   */
  prune(
    ids: Iterable<string>,
    scopeOf: (run: ExecutionRun) => string
  ): readonly ExecutionRun[];
  queues(): readonly QueueState[];
  /**
   * Every change from now on, each as the whole new record. The snapshot is
   * taken in the same tick, so snapshot and updates together miss nothing;
   * reconcile by `id`, keeping the highest `revision`. After a disconnect,
   * subscribe again for a fresh snapshot.
   */
  subscribe(listener: (run: ExecutionRun) => void): ExecutionSubscription;
}

/** A run waiting for its queue to let it in. */
interface Waiting {
  /** Called when the run cannot be recorded as running, instead of `start`. */
  readonly fail: (error: unknown) => void;
  readonly id: string;
  /** Called with the run's input once it is admitted and recorded as running. */
  readonly start: (input: unknown) => Promise<void>;
  started?: Promise<void>;
}

interface Lane {
  readonly active: Set<string>;
  concurrency: number;
  readonly waiting: Waiting[];
}

export interface EnqueueInput {
  readonly correlation?: Readonly<Record<string, string>>;
  readonly input?: unknown;
  readonly kind: ExecutionRun["kind"];
  readonly name: string;
  readonly queue: string;
  readonly source?: string;
}

function validConcurrency(queue: string, concurrency: number): number {
  if (
    concurrency === Number.POSITIVE_INFINITY ||
    (Number.isInteger(concurrency) && concurrency >= 1)
  ) {
    return concurrency;
  }
  throw new Error(
    `queue "${queue}": concurrency must be a positive integer or Infinity, not ${String(concurrency)}`
  );
}

function now(): string {
  return new Date().toISOString();
}

/**
 * A stored record, when it has every field a run needs. An unsettled run's
 * record leaves its observations to its log.
 */
function parseRun(value: unknown): ExecutionRun | undefined {
  if (
    !(isRecord(value) && isRecord(value.owner) && isRecord(value.timestamps))
  ) {
    return undefined;
  }
  const valid =
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.queue === "string" &&
    typeof value.status === "string" &&
    STATUSES.has(value.status) &&
    (value.kind === "workflow" || value.kind === "task") &&
    typeof value.revision === "number" &&
    typeof value.sequence === "number" &&
    typeof value.owner.pid === "number" &&
    typeof value.timestamps.queuedAt === "string" &&
    isRecord(value.correlation) &&
    (value.observations === undefined || Array.isArray(value.observations));
  return valid
    ? ({ observations: [], ...value } as unknown as ExecutionRun)
    : undefined;
}

/** What one observation appends to its run's log. */
interface LoggedObservation {
  readonly observation: ExecutionObservation;
  readonly revision: number;
  readonly updatedAt: string;
}

function isLogged(value: unknown): value is LoggedObservation {
  return (
    isRecord(value) &&
    isRecord(value.observation) &&
    typeof value.observation.id === "string" &&
    typeof value.revision === "number" &&
    typeof value.updatedAt === "string"
  );
}

/** `observations` with `observation` recorded: replacing one by id moves it last. */
function withObservation(
  observations: readonly ExecutionObservation[],
  observation: ExecutionObservation
): ExecutionObservation[] {
  return [
    ...observations.filter((item) => item.id !== observation.id),
    observation,
  ];
}

/** The one `retention` document: every scope's gap. */
const GAPS_KEY = "gaps";

function parseGaps(value: unknown): Map<string, RetentionGap> {
  const gaps = new Map<string, RetentionGap>();
  const stored = isRecord(value) && isRecord(value.gaps) ? value.gaps : {};
  for (const [scope, gap] of Object.entries(stored)) {
    if (
      isRecord(gap) &&
      typeof gap.removed === "number" &&
      typeof gap.through === "string" &&
      typeof gap.updatedAt === "string"
    ) {
      gaps.set(scope, {
        removed: gap.removed,
        scope,
        through: gap.through,
        updatedAt: gap.updatedAt,
      });
    }
  }
  return gaps;
}

function bySequence(a: ExecutionRun, b: ExecutionRun): number {
  return a.sequence - b.sequence || a.id.localeCompare(b.id);
}

/** The engine's side of {@link ExecutionRuns}: it admits, records, and settles. */
export class Executions implements ExecutionRuns {
  readonly #store: StateStore;
  readonly #warn: (line: string) => void;
  readonly #records = new Map<string, ExecutionRun>();
  readonly #lanes = new Map<string, Lane>();
  readonly #listeners = new Set<(run: ExecutionRun) => void>();
  readonly #idle = new Set<() => void>();
  readonly #removed: (run: ExecutionRun) => void;
  #gaps = new Map<string, RetentionGap>();
  #sequence = 0;

  constructor(options: {
    readonly queues?: Readonly<Record<string, QueueSettings>>;
    /** Told of each pruned run once its record is gone, to drop what else it kept. */
    readonly removed?: (run: ExecutionRun) => void;
    readonly store: StateStore;
    readonly warn: (line: string) => void;
  }) {
    this.#store = options.store;
    this.#warn = options.warn;
    this.#removed = options.removed ?? (() => undefined);
    for (const [name, settings] of Object.entries(options.queues ?? {})) {
      this.configure(name, settings);
    }
  }

  configure(queue: string, settings: QueueSettings): void {
    const concurrency = validConcurrency(queue, settings.concurrency);
    const lane = this.#lane(queue);
    lane.concurrency = concurrency;
    this.#pump(lane);
  }

  gaps(): readonly RetentionGap[] {
    return [...this.#gaps.values()];
  }

  get(id: string): ExecutionRun | undefined {
    return this.#records.get(id);
  }

  prune(
    ids: Iterable<string>,
    scopeOf: (run: ExecutionRun) => string
  ): readonly ExecutionRun[] {
    const runs = [...new Set(ids)].flatMap((id) => {
      const run = this.#records.get(id);
      return run && SETTLED_EXECUTION_STATUSES.has(run.status) ? [run] : [];
    });
    if (runs.length === 0) {
      return [];
    }
    const at = now();
    const gaps = new Map(this.#gaps);
    for (const run of runs) {
      const scope = scopeOf(run);
      const gap = gaps.get(scope);
      const settled = run.timestamps.settledAt ?? run.timestamps.updatedAt;
      gaps.set(scope, {
        removed: (gap?.removed ?? 0) + 1,
        scope,
        through: gap && gap.through > settled ? gap.through : settled,
        updatedAt: at,
      });
    }
    // The gap is on disk before any record goes: a crash in between claims
    // a gap a little early, never hides one.
    this.#store.write("retention", GAPS_KEY, {
      gaps: Object.fromEntries(
        [...gaps].map(([key, gap]) => [
          key,
          {
            removed: gap.removed,
            through: gap.through,
            updatedAt: gap.updatedAt,
          },
        ])
      ),
    });
    this.#gaps = gaps;
    const removed: ExecutionRun[] = [];
    for (const run of runs) {
      try {
        this.#store.remove("executions", run.id);
        // Nothing, unless a crash came between settling and dropping it.
        this.#store.remove("observations", run.id);
      } catch (error) {
        this.#warn(`[state] execution ${run.id} not removed: ${String(error)}`);
        continue;
      }
      this.#records.delete(run.id);
      removed.push(run);
      try {
        this.#removed(run);
      } catch (error) {
        this.#warn(`[state] run ${run.id} not fully removed: ${String(error)}`);
      }
    }
    return removed;
  }

  list(): readonly ExecutionRun[] {
    return [...this.#records.values()].sort(bySequence);
  }

  queues(): readonly QueueState[] {
    return [...this.#lanes].map(([name, lane]) => ({
      active: lane.active.size,
      concurrency: lane.concurrency,
      name,
      waiting: lane.waiting.length,
    }));
  }

  subscribe(listener: (run: ExecutionRun) => void): ExecutionSubscription {
    this.#listeners.add(listener);
    return {
      snapshot: this.list(),
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  /** Read what the store retains; an unreadable record is skipped with a warning. */
  load(): void {
    this.#gaps = parseGaps(this.#store.read("retention", GAPS_KEY));
    for (const document of this.#store.list("executions")) {
      const run = this.#folded(parseRun(document.value));
      if (run === undefined) {
        this.#warn(
          `[state] skipped executions/${document.key}: ${document.error ?? "not an execution run"}`
        );
        continue;
      }
      this.#records.set(run.id, run);
      this.#sequence = Math.max(this.#sequence, run.sequence);
    }
  }

  /**
   * Record a run as queued, durably, before anything admits it. A source
   * that already has a retained run under the same name returns that run
   * instead. Throws when the record cannot be written: a run that is not
   * recorded does not exist.
   */
  enqueue(request: EnqueueInput): {
    readonly existing: boolean;
    readonly run: ExecutionRun;
  } {
    if (request.source !== undefined) {
      const existing = [...this.#records.values()].find(
        (candidate) =>
          candidate.source === request.source && candidate.name === request.name
      );
      if (existing) {
        return { existing: true, run: existing };
      }
    }
    this.#sequence = Math.max(Date.now(), this.#sequence + 1);
    const at = now();
    const run: ExecutionRun = {
      correlation: { ...request.correlation },
      id: `rn-${randomUUID()}`,
      ...(request.input === undefined
        ? {}
        : { input: request.input as JsonValue }),
      kind: request.kind,
      name: request.name,
      observations: [],
      owner: { pid: process.pid },
      queue: request.queue,
      revision: 1,
      sequence: this.#sequence,
      ...(request.source === undefined ? {} : { source: request.source }),
      status: "queued",
      timestamps: { queuedAt: at, updatedAt: at },
    };
    this.#write(run);
    return { existing: false, run };
  }

  /**
   * Wait in the run's queue. Once admitted, the run is recorded as running,
   * which drops its input from the record, and `start` is called with that
   * input; a run that cannot be recorded as running is recorded failed and
   * handed to `fail` without starting. Returns the start when the queue let
   * it in at once.
   */
  admit(
    id: string,
    start: (input: unknown) => Promise<void>,
    fail: (error: unknown) => void
  ): Promise<void> | undefined {
    const run = this.#require(id);
    const lane = this.#lane(run.queue);
    const waiting: Waiting = { fail, id, start };
    lane.waiting.push(waiting);
    this.#pump(lane);
    return waiting.started;
  }

  /** Give up a running run's slot; the run itself goes on. */
  release(id: string): void {
    const run = this.#records.get(id);
    const lane = run && this.#lanes.get(run.queue);
    if (lane?.active.delete(id)) {
      this.#pump(lane);
      this.#checkIdle();
    }
  }

  /** Parked on a question or a pause: its slot goes to the next run. */
  suspend(id: string): void {
    this.#change(id, { status: "suspended" });
    this.release(id);
  }

  /** Back from a park: it takes its slot again without waiting. */
  resume(id: string): void {
    const run = this.#change(id, { status: "running" });
    if (run) {
      this.#lane(run.queue).active.add(id);
    }
  }

  progress(id: string, value: JsonValue): void {
    this.#change(id, { progress: value });
  }

  /**
   * Record or replace an observation by id, appended to the run's log. True
   * once it is durably recorded; false for an unknown or settled run, or a
   * failed write (the change still holds in this process).
   */
  observe(id: string, observation: ExecutionObservation): boolean {
    const run = this.#records.get(id);
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return false;
    }
    const changed = nextRevision(run, {
      observations: withObservation(run.observations, observation),
    });
    try {
      this.#store.append("observations", id, {
        observation,
        revision: changed.revision,
        updatedAt: changed.timestamps.updatedAt,
      } satisfies LoggedObservation);
      return true;
    } catch (error) {
      this.#warn(
        `[state] execution ${id} observation not saved: ${String(error)}`
      );
      return false;
    } finally {
      this.#publish(changed);
    }
  }

  /** Record how a run ended and free its slot. */
  settle(
    id: string,
    status: "complete" | "failed" | "cancelled" | "interrupted",
    error?: { readonly code: string; readonly message?: string }
  ): void {
    const run = this.#records.get(id);
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return;
    }
    const at = now();
    const { input: _input, ...rest } = run;
    this.#commit({
      ...rest,
      ...(error === undefined ? {} : { error }),
      revision: run.revision + 1,
      status,
      timestamps: { ...run.timestamps, settledAt: at, updatedAt: at },
    });
    const lane = this.#lanes.get(run.queue);
    if (lane) {
      lane.active.delete(id);
      this.#pump(lane);
    }
    this.#checkIdle();
  }

  /**
   * Take a queued run off its queue and record it cancelled; `false` when it
   * is not waiting here or in a process that has exited.
   */
  withdraw(id: string): boolean {
    const run = this.#records.get(id);
    if (run?.status !== "queued") {
      return false;
    }
    const lane = this.#lanes.get(run.queue);
    const index = lane?.waiting.findIndex((item) => item.id === id) ?? -1;
    if (lane && index >= 0) {
      lane.waiting.splice(index, 1);
    } else if (!exited(run.owner.pid)) {
      // Queued in another live process: that process cancels it.
      return false;
    }
    this.settle(id, "cancelled");
    return true;
  }

  /** Runs waiting in this process's queues, in admission order. */
  waiting(): readonly string[] {
    return [...this.#lanes.values()].flatMap((lane) =>
      lane.waiting.map((item) => item.id)
    );
  }

  /** Resolves once no queue has a run waiting or holding a slot. */
  drained(): Promise<void> {
    return new Promise((resolve) => {
      this.#idle.add(resolve);
      this.#checkIdle();
    });
  }

  /**
   * Take over the unsettled runs of processes that have exited. Running
   * work is recorded `interrupted`. A parked run this engine adopted is now
   * its own. A queued run `readmit` accepts is now its own, and is returned,
   * in admission order, for the caller to admit; any other is left queued
   * for a process that can run it.
   */
  recover(options: {
    readonly adopted: ReadonlySet<string>;
    readonly readmit: (run: ExecutionRun) => boolean;
    /** How a workflow's own run file says it ended, when its record did not get there. */
    readonly settled?: (
      run: ExecutionRun
    ) => "complete" | "failed" | "cancelled" | undefined;
  }): readonly ExecutionRun[] {
    const readmitted: ExecutionRun[] = [];
    const orphans = this.list().filter(
      (run) =>
        !SETTLED_EXECUTION_STATUSES.has(run.status) &&
        (options.adopted.has(run.id) || exited(run.owner.pid))
    );
    for (const orphan of orphans) {
      const lock = this.#store.lock(`execution-${orphan.id}`);
      if ("holder" in lock) {
        continue;
      }
      try {
        const run = this.#folded(
          parseRun(this.#store.read("executions", orphan.id))
        );
        const ours = run && options.adopted.has(run.id);
        if (
          !run ||
          SETTLED_EXECUTION_STATUSES.has(run.status) ||
          !(ours || exited(run.owner.pid))
        ) {
          continue;
        }
        this.#records.set(run.id, run);
        if (ours) {
          this.#change(run.id, { owner: { pid: process.pid } });
        } else if (run.status === "running") {
          this.#change(run.id, { owner: { pid: process.pid } });
          const ended = options.settled?.(run);
          if (ended === undefined) {
            this.settle(run.id, "interrupted", {
              code: "interrupted",
              message: "its process exited while it was running",
            });
          } else {
            this.settle(run.id, ended);
          }
        } else if (run.status === "queued" && options.readmit(run)) {
          readmitted.push(
            this.#change(run.id, { owner: { pid: process.pid } }) ?? run
          );
        }
      } finally {
        lock.release();
      }
    }
    return readmitted.sort(bySequence);
  }

  #lane(name: string): Lane {
    let lane = this.#lanes.get(name);
    if (!lane) {
      lane = {
        active: new Set(),
        concurrency: DEFAULT_CONCURRENCY,
        waiting: [],
      };
      this.#lanes.set(name, lane);
    }
    return lane;
  }

  /** Let in waiting runs, first come first served, while the queue has room. */
  #pump(lane: Lane): void {
    while (lane.active.size < lane.concurrency) {
      const next = lane.waiting.shift();
      if (!next) {
        return;
      }
      lane.active.add(next.id);
      next.started = this.#start(next);
      // Whoever awaits it sees the failure; `start` and `fail` handle it otherwise.
      next.started.catch(() => undefined);
    }
  }

  async #start({ fail, id, start }: Waiting): Promise<void> {
    const run = this.#require(id);
    const at = now();
    const { input, ...rest } = run;
    // Running is on disk before the first effect, or the run does not start.
    try {
      this.#write({
        ...rest,
        revision: run.revision + 1,
        status: "running",
        timestamps: { ...run.timestamps, startedAt: at, updatedAt: at },
      });
    } catch (error) {
      this.settle(id, "failed", { code: "not_recorded" });
      fail(error);
      throw error;
    }
    await start(input);
  }

  #require(id: string): ExecutionRun {
    const run = this.#records.get(id);
    if (!run) {
      throw new Error(`execution run ${id} is not recorded`);
    }
    return run;
  }

  /**
   * Apply a change to a known, unsettled run; a failed write warns and the
   * change still holds here. A settled run never changes.
   */
  #change(
    id: string,
    patch: Partial<Omit<ExecutionRun, "id" | "revision">>
  ): ExecutionRun | undefined {
    const run = this.#records.get(id);
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return undefined;
    }
    const changed = nextRevision(run, patch);
    this.#commit(changed);
    return changed;
  }

  /** Persist and publish; a failed write warns, publishes anyway and returns false. */
  #commit(run: ExecutionRun): boolean {
    try {
      this.#write(run);
      return true;
    } catch (error) {
      this.#warn(`[state] execution ${run.id} not saved: ${String(error)}`);
      this.#publish(run);
      return false;
    }
  }

  /**
   * Persist, then publish. Throws when the store refuses the write. An
   * unsettled run's observations stay in its log; the settled record takes
   * them, and only once it is written does the log go.
   */
  #write(run: ExecutionRun): void {
    const settled = SETTLED_EXECUTION_STATUSES.has(run.status);
    const { observations: _observations, ...unsettled } = run;
    this.#store.write(
      "executions",
      run.id,
      (settled ? run : unsettled) as unknown as Record<string, unknown>
    );
    this.#publish(run);
    if (settled) {
      try {
        this.#store.remove("observations", run.id);
      } catch (error) {
        this.#warn(
          `[state] execution ${run.id} log not removed: ${String(error)}`
        );
      }
    }
  }

  /** A stored unsettled run with its logged observations folded back in. */
  #folded(run: ExecutionRun | undefined): ExecutionRun | undefined {
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return run;
    }
    const observations = new Map(
      run.observations.map((item) => [item.id, item])
    );
    let { revision } = run;
    let { updatedAt } = run.timestamps;
    for (const entry of this.#store.log("observations", run.id)) {
      if (isLogged(entry)) {
        // Replacing one by id moves it last, as `observe` does.
        observations.delete(entry.observation.id);
        observations.set(entry.observation.id, entry.observation);
        revision = Math.max(revision, entry.revision);
        updatedAt = entry.updatedAt > updatedAt ? entry.updatedAt : updatedAt;
      }
    }
    return {
      ...run,
      observations: [...observations.values()],
      revision,
      timestamps: { ...run.timestamps, updatedAt },
    };
  }

  #publish(run: ExecutionRun): void {
    this.#records.set(run.id, run);
    for (const listener of this.#listeners) {
      try {
        listener(run);
      } catch (error) {
        this.#warn(`[executions] a subscriber failed: ${String(error)}`);
      }
    }
  }

  #checkIdle(): void {
    const busy = [...this.#lanes.values()].some(
      (lane) => lane.active.size > 0 || lane.waiting.length > 0
    );
    if (busy) {
      return;
    }
    for (const resolve of this.#idle) {
      resolve();
    }
    this.#idle.clear();
  }
}

/** Another process that has exited; this process is never one. */
function exited(pid: number): boolean {
  return pid !== process.pid && !processAlive(pid);
}

/** The next revision of a run with `patch` applied. */
function nextRevision(
  run: ExecutionRun,
  patch: Partial<Omit<ExecutionRun, "id" | "revision">>
): ExecutionRun {
  return {
    ...run,
    ...patch,
    revision: run.revision + 1,
    timestamps: { ...run.timestamps, ...patch.timestamps, updatedAt: now() },
  };
}
