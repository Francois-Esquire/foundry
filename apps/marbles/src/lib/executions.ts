import { processAlive } from "@foundry/lib/file-lock";
import {
  type ExecutionRun,
  type ExecutionRuns,
  now,
  type QueueSettings,
  type QueueState,
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

  /** Parked on a question or a pause: its slot goes to the next run. */
  suspend(id: string): void {
    this.changeRecord(id, { status: "suspended" });
    this.release(id);
  }

  /** Back from a park: it takes its slot again without waiting. */
  resume(id: string): void {
    const run = this.changeRecord(id, { status: "running" });
    if (run) {
      this.#lane(run.queue).active.add(id);
    }
  }

  /**
   * Take a queued run off its queue and record it cancelled; `false` when it
   * is not waiting here or in a process that has exited. A run this process
   * recorded queued but has not yet handed to its queue, which a subscriber
   * told of it can cancel from that very update, is withdrawn too: nothing
   * of it has run.
   */
  withdraw(id: string): boolean {
    const run = this.get(id);
    if (run?.status !== "queued") {
      return false;
    }
    const lane = this.#lanes.get(run.queue);
    const index = lane?.waiting.findIndex((item) => item.id === id) ?? -1;
    if (lane && index >= 0) {
      lane.waiting.splice(index, 1);
    } else if (run.owner.pid !== process.pid && processAlive(run.owner.pid)) {
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
    const run = this.requireRecord(id);
    const at = now();
    const { input, ...rest } = run;
    // Running is on disk before the first effect, or the run does not start.
    try {
      this.writeRecord({
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
  override settle(
    id: string,
    status: "complete" | "failed" | "cancelled" | "interrupted",
    error?: { readonly code: string; readonly message?: string }
  ): void {
    const run = this.get(id);
    if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
      return;
    }
    super.settle(id, status, error);
    const lane = this.#lanes.get(run.queue);
    if (lane) {
      lane.active.delete(id);
      this.#pump(lane);
    }
    this.#checkIdle();
  }
}
