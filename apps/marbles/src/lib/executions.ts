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
import type { ExecutionView } from "./execution-store";

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
  readonly parent?: string;
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
  readonly #withdrawing = new Set<string>();
  #closed = false;
  readonly #kept = new Set<string>();
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
    fail: (error: unknown) => void,
    parent?: string
  ): Promise<void> | undefined {
    const run = this.requireRecord(id);
    const lane = this.#lane(run.queue);
    const waiting: Waiting = {
      fail,
      id,
      start,
      ...(parent === undefined ? {} : { parent }),
    };
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `closeAdmission` sets it.
    if (this.#closed && parent !== undefined) {
      this.#kept.add(id);
    }
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

  closeAdmission(active: (runId: string) => boolean): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; this sets it.
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const lane of this.#lanes.values()) {
      for (const item of lane.waiting) {
        if (item.parent !== undefined && active(item.parent)) {
          this.#kept.add(item.id);
        }
      }
    }
  }

  async handOverAll(
    choose: (view: ExecutionView) => Promise<ProcessIdentity | undefined>,
    onHanded: (id: string) => void
  ): Promise<{
    readonly failed: readonly {
      readonly error: unknown;
      readonly id: string;
    }[];
  }> {
    const failed: { readonly error: unknown; readonly id: string }[] = [];
    for (const id of this.waiting().filter((each) => !this.#kept.has(each))) {
      try {
        if (await this.#handOver(id, choose)) {
          onHanded(id);
        }
      } catch (error) {
        failed.push({ error, id });
      }
    }
    return { failed };
  }

  async #handOver(
    id: string,
    choose: (view: ExecutionView) => Promise<ProcessIdentity | undefined>
  ): Promise<boolean> {
    const run = this.get(id);
    if (run?.status !== "queued") {
      return false;
    }
    this.#withdrawing.add(id);
    let handed = false;
    try {
      handed = await this.handQueued(id, choose);
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

  #pump(lane: Lane): void {
    while (lane.active.size < lane.concurrency) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; `closeAdmission` sets it.
      const index = this.#closed
        ? lane.waiting.findIndex((item) => this.#kept.has(item.id))
        : 0;
      const next = index === -1 ? undefined : lane.waiting[index];
      if (!next || this.#withdrawing.has(next.id)) {
        return;
      }
      lane.waiting.splice(index, 1);
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
