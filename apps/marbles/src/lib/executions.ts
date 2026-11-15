import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type {
  ExecutionRun,
  ExecutionRuns,
  QueueSettings,
  QueueState,
} from "./execution-record";
import {
  ExecutionRecords,
  type ExecutionRecordsOptions,
} from "./execution-records";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";

export type {
  ExecutionObservation,
  ExecutionRun,
  ExecutionRuns,
  ExecutionSubscription,
  ExecutionUsage,
  HostObservation,
  ModelTurnObservation,
  ObservationStatus,
  QueueSettings,
  QueueState,
  RetentionGap,
  ToolCallObservation,
} from "./execution-record";
// biome-ignore lint/performance/noBarrelFile: Preserve the existing execution API while its record boundary has a canonical home.
export { DEFAULT_QUEUE } from "./execution-record";

const DEFAULT_CONCURRENCY = 1;

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

/** Named FIFO admission over one inherited record authority; no storage encoding or duplicate record cache. */
export class Executions extends ExecutionRecords implements ExecutionRuns {
  readonly #lanes = new Map<string, Lane>();
  readonly #idle = new Set<() => void>();
  /** Runs whose cancellation is being written: each holds its queue's place. */
  readonly #withdrawing = new Set<string>();
  /** Set while every waiting run is handed over: no queue lets anything in. */
  #frozen = false;
  constructor(
    options: ExecutionRecordsOptions & {
      readonly queues?: Readonly<Record<string, QueueSettings>>;
    }
  ) {
    super(options);
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

  queues(): readonly QueueState[] {
    return [...this.#lanes].map(([name, lane]) => ({
      active: lane.active.size,
      concurrency: lane.concurrency,
      name,
      waiting: lane.waiting.length,
    }));
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
    const run = this.requireRecord(id);
    const lane = this.#lane(run.queue);
    const waiting: Waiting = { fail, id, start };
    lane.waiting.push(waiting);
    this.#pump(lane);
    return waiting.started;
  }

  /** Give up a running run's slot; the run itself goes on. */
  release(id: string): void {
    const run = this.get(id);
    const lane = run && this.#lanes.get(run.queue);
    if (lane?.active.delete(id)) {
      this.#pump(lane);
      this.#checkIdle();
    }
  }

  /**
   * Parked on a question or a pause: its slot goes to the next run, and
   * its record is parked in its turn (left as it is when its Run's commit
   * parked it already, `follows`).
   */
  suspend(id: string): void {
    this.moveRecord(id, "suspended");
    this.release(id);
  }

  /** Back from a park: it takes its slot again without waiting. */
  resume(id: string): void {
    const run = this.get(id);
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return;
    }
    this.moveRecord(id, "running");
    this.#lane(run.queue).active.add(id);
  }

  /**
   * Take a queued run off its queue and record it cancelled; resolves
   * `false` when it is not queued here or in a process that has exited. The
   * decision is made on the stored record, in the transaction that cancels
   * it, never on what this process last saw: a run another process has
   * since taken over or started is left to it. A run this process recorded
   * queued but has not yet handed to its queue, which a subscriber told of
   * it can cancel from that very update, is withdrawn too: nothing of it
   * has run. While the cancellation is written the run keeps its place in
   * its queue and nothing behind it is let in, so the queue's order holds
   * whichever way it goes: cancelled, it leaves; refused or failed, it is
   * next. Resolves once the cancellation is stored; rejects when it cannot
   * be, cancelling nothing.
   */
  async withdraw(id: string): Promise<boolean> {
    const run = this.get(id);
    if (run?.status !== "queued") {
      return false;
    }
    this.#withdrawing.add(id);
    let cancelled = false;
    try {
      cancelled = await this.cancelQueued(id);
    } finally {
      this.#withdrawing.delete(id);
      const lane = this.#lane(run.queue);
      if (cancelled) {
        const index = lane.waiting.findIndex((item) => item.id === id);
        if (index >= 0) {
          lane.waiting.splice(index, 1);
        }
      }
      this.#pump(lane);
      this.#checkIdle();
    }
    return cancelled;
  }

  /**
   * Take every run waiting in this process's queues off them and make each
   * `successor`'s, still queued (`handQueued`), in their order; resolves
   * with the ids handed over. No queue lets a run in from the moment this
   * begins until every one is handed over, so a slot that frees meanwhile
   * (a run that parks, a task that gives its slot up) starts none of them
   * here. One no longer queued here stays as it is, and is let in
   * afterwards if it is still waiting.
   */
  async handOverAll(successor: ProcessIdentity): Promise<readonly string[]> {
    this.#frozen = true;
    const handed: string[] = [];
    try {
      for (const id of this.waiting()) {
        if (await this.#handOver(id, successor)) {
          handed.push(id);
        }
      }
    } finally {
      this.#frozen = false;
      for (const lane of this.#lanes.values()) {
        this.#pump(lane);
      }
      this.#checkIdle();
    }
    return handed;
  }

  /**
   * Take a queued run off its queue and make it `successor`'s, still
   * queued (`handQueued`); resolves `false`, leaving it here, when it is not
   * queued here. It holds its queue's place while that is written, as a
   * withdrawal does.
   */
  async #handOver(id: string, successor: ProcessIdentity): Promise<boolean> {
    const run = this.get(id);
    if (run?.status !== "queued") {
      return false;
    }
    this.#withdrawing.add(id);
    let handed = false;
    try {
      handed = await this.handQueued(id, successor);
    } finally {
      this.#withdrawing.delete(id);
      const lane = this.#lane(run.queue);
      if (handed) {
        const index = lane.waiting.findIndex((item) => item.id === id);
        if (index >= 0) {
          lane.waiting.splice(index, 1);
        }
      }
      this.#pump(lane);
      this.#checkIdle();
    }
    return handed;
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

  /**
   * Let in waiting runs, first come first served, while the queue has room;
   * one being withdrawn holds its place, and nothing behind it goes first.
   */
  #pump(lane: Lane): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `handOverAll` sets it.
    while (!this.#frozen && lane.active.size < lane.concurrency) {
      const [next] = lane.waiting;
      if (!next || this.#withdrawing.has(next.id)) {
        return;
      }
      lane.waiting.shift();
      lane.active.add(next.id);
      next.started = this.#start(next);
      // Whoever awaits it sees the failure; `start` and `fail` handle it otherwise.
      next.started.catch(() => undefined);
    }
  }

  async #start({ fail, id, start }: Waiting): Promise<void> {
    const { input } = this.requireRecord(id);
    // Running is on disk before the first effect, or the run does not start.
    try {
      await this.startRecord(id);
    } catch (error) {
      // Settled failed if it can be; a settle that cannot be written is
      // kept to try again, and the run does not start either way.
      await this.settle(id, "failed", { code: "not_recorded" }).catch(
        () => undefined
      );
      fail(error);
      throw error;
    }
    await start(input);
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

  private requireRecord(id: string): ExecutionRun {
    const run = this.get(id);
    if (!run) {
      throw new Error(`execution run ${id} is not recorded`);
    }
    return run;
  }
  /**
   * Record how a run ended and free its slot; a run already settled frees
   * its slot too, whatever settled it. Resolves once the record is on disk;
   * rejects when it cannot be written, the slot freed all the same, since
   * the run's work has ended (`ExecutionRecords.settle`).
   */
  override settle(
    id: string,
    status: "complete" | "failed" | "cancelled" | "interrupted",
    error?: { readonly code: string; readonly message?: string }
  ): Promise<ExecutionRun | undefined> {
    const run = this.get(id);
    if (!run) {
      return Promise.resolve(undefined);
    }
    const written = super.settle(id, status, error);
    const lane = this.#lanes.get(run.queue);
    if (lane?.active.delete(id)) {
      this.#pump(lane);
    }
    this.#checkIdle();
    return written;
  }
}
