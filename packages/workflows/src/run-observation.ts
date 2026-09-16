import { RunNotFoundError, RunReplayGapError } from "./errors";
import type { RunFrame, RunFramePayload } from "./execution-records";
import type { JsonValue, OrchestratorStore } from "./store";

/** Named temporary retention policy for the platform proof. */
export const RUN_FRAME_RETENTION_POLICY = "retain-all-proof" as const;

export interface ObserveRunOptions {
  /** Replay frames whose cursor is strictly greater than this value. */
  readonly after?: number;
}

/** Replayable, detachable frame stream. Closing it never affects execution. */
export interface RunObservation extends AsyncIterable<RunFrame> {
  close(): void;
}

interface PendingNext {
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: IteratorResult<RunFrame>) => void;
}

class BufferedRunObservation
  implements RunObservation, AsyncIterator<RunFrame>
{
  readonly #buffer: RunFrame[] = [];
  readonly #waiting: PendingNext[] = [];
  readonly #detach: () => void;
  #closed = false;
  #detached = false;
  #failure: Error | null = null;

  constructor(detach: () => void) {
    this.#detach = detach;
  }

  [Symbol.asyncIterator](): AsyncIterator<RunFrame> {
    return this;
  }

  next(): Promise<IteratorResult<RunFrame>> {
    const frame = this.#buffer.shift();
    if (frame) {
      return Promise.resolve({ done: false, value: frame });
    }
    if (this.#failure !== null) {
      return Promise.reject(this.#failure);
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.#waiting.push({ reject, resolve });
    });
  }

  return(): Promise<IteratorResult<RunFrame>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  close(): void {
    if (this.#detached) {
      return;
    }
    this.#detached = true;
    this.#closed = true;
    this.#buffer.length = 0;
    this.#detach();
    this.#finishWaiting();
  }

  push(frame: RunFrame): void {
    if (this.#closed) {
      return;
    }
    const waiting = this.#waiting.shift();
    if (waiting) {
      waiting.resolve({ done: false, value: frame });
      return;
    }
    this.#buffer.push(frame);
  }

  finishAfterReplay(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#finishWaiting();
  }

  fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    const failure = toError(error);
    this.#failure = failure;
    this.#closed = true;
    for (const waiting of this.#waiting.splice(0)) {
      waiting.reject(failure);
    }
  }

  #finishWaiting(): void {
    for (const waiting of this.#waiting.splice(0)) {
      waiting.resolve({ done: true, value: undefined });
    }
  }
}

/**
 * Durable per-Run journal. One per-run lock covers both publish and observe so
 * replay plus live attachment has no gap. Subscriber delivery is synchronous
 * enqueue only; consumers drain their own buffers at any speed.
 */
export class RunObservationJournal {
  readonly #store: OrchestratorStore;
  readonly #observers = new Map<string, Set<BufferedRunObservation>>();
  readonly #failures = new Map<string, unknown>();
  readonly #mutationTails = new Map<string, Promise<void>>();

  constructor(store: OrchestratorStore) {
    this.#store = store;
  }

  publish(
    runId: string,
    payload: RunFramePayload,
    at?: number
  ): Promise<RunFrame> {
    return this.#withRunLock(runId, () =>
      this.#publishLocked(runId, payload, at)
    );
  }

  /**
   * Durably reserve one effect key for a Run before the caller performs it.
   * The claim marker shares the publication lock and ordered journal, so a
   * recovered process sees the reservation even when workflow snapshots lag.
   */
  claimEffect(
    runId: string,
    key: string,
    metadata?: JsonValue
  ): Promise<boolean> {
    return this.#withRunLock(runId, async () => {
      const frame = await this.#store.claimRunEffect({
        key,
        runId,
        ...(metadata === undefined ? {} : { metadata }),
      });
      if (frame === null) {
        return false;
      }
      this.#deliverFrame(frame);
      return true;
    });
  }

  observe(
    runId: string,
    options: ObserveRunOptions = {}
  ): Promise<RunObservation> {
    const after = options.after ?? -1;
    if (!Number.isInteger(after) || after < -1) {
      return Promise.reject(
        new RangeError("Run observation cursor must be an integer >= -1")
      );
    }
    return this.#withRunLock(runId, async () => {
      let retained = await this.#store.listRunFrames(runId);
      const run = await this.#store.getRun(runId);
      if (!run) {
        throw new RunNotFoundError(runId);
      }
      if (isTerminalStatus(run.status) && !retained.some(isTerminalFrame)) {
        const terminal = await this.#store.appendRunFrame({
          payload: {
            kind: "lifecycle",
            value: {
              event: run.status,
              reconciled: true,
              status: run.status,
              step: run.step,
            },
          },
          runId,
        });
        retained = [...retained, terminal];
        this.#failures.delete(runId);
        const existingObservers = this.#observers.get(runId);
        if (existingObservers) {
          for (const observer of existingObservers) {
            observer.push(terminal);
            observer.finishAfterReplay();
          }
          this.#observers.delete(runId);
        }
      }
      const earliest = retained[0]?.cursor;
      const latest = retained.at(-1)?.cursor ?? -1;
      if (earliest !== undefined && earliest > after + 1) {
        throw new RunReplayGapError(runId, after, earliest, latest);
      }
      if (after > latest) {
        throw new RunReplayGapError(runId, after, earliest ?? 0, latest);
      }

      let observers = this.#observers.get(runId);
      if (!observers) {
        observers = new Set();
        this.#observers.set(runId, observers);
      }
      const subscribed = observers;
      const observation = new BufferedRunObservation(() => {
        subscribed.delete(observation);
        if (subscribed.size === 0) {
          this.#observers.delete(runId);
        }
      });
      for (const frame of retained) {
        if (frame.cursor > after) {
          observation.push(frame);
        }
      }

      const failure = this.#failures.get(runId);
      if (failure !== undefined) {
        observation.fail(failure);
        if (subscribed.size === 0) {
          this.#observers.delete(runId);
        }
      } else if (retained.some(isTerminalFrame)) {
        observation.finishAfterReplay();
        if (subscribed.size === 0) {
          this.#observers.delete(runId);
        }
      } else {
        subscribed.add(observation);
      }
      return observation;
    });
  }

  fail(runId: string, error: unknown): Promise<void> {
    return this.#withRunLock(runId, () => {
      const failure = toError(error);
      this.#failures.set(runId, failure);
      const observers = this.#observers.get(runId);
      if (observers) {
        for (const observer of observers) {
          observer.fail(failure);
        }
      }
      this.#observers.delete(runId);
      return Promise.resolve();
    });
  }

  /** Delete a Run and its retained journal under the publication lock. */
  deleteRun(runId: string): Promise<void> {
    return this.#withRunLock(runId, async () => {
      await this.#store.deleteRunFrames(runId);
      await this.#store.deleteRun(runId);
      const observers = this.#observers.get(runId);
      if (observers) {
        const error = new RunNotFoundError(runId);
        for (const observer of observers) {
          observer.fail(error);
        }
      }
      this.#observers.delete(runId);
      this.#failures.delete(runId);
    });
  }

  async #withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(runId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#mutationTails.set(runId, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#mutationTails.get(runId) === current) {
        this.#mutationTails.delete(runId);
      }
    }
  }

  async #publishLocked(
    runId: string,
    payload: RunFramePayload,
    at?: number
  ): Promise<RunFrame> {
    const frame = await this.#store.appendRunFrame({
      payload,
      runId,
      ...(at === undefined ? {} : { at }),
    });
    this.#deliverFrame(frame);
    return frame;
  }

  #deliverFrame(frame: RunFrame): void {
    const { runId } = frame;
    const observers = this.#observers.get(runId);
    if (observers) {
      for (const observer of observers) {
        observer.push(frame);
      }
    }
    if (isTerminalFrame(frame)) {
      if (observers) {
        for (const observer of observers) {
          observer.finishAfterReplay();
        }
      }
      this.#observers.delete(runId);
    }
  }
}

function isTerminalFrame(frame: RunFrame): boolean {
  if (frame.payload.kind !== "lifecycle") {
    return false;
  }
  const value = frame.payload.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const event = (value as Readonly<Record<string, unknown>>).event;
  return event === "complete" || event === "failed" || event === "cancelled";
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isTerminalStatus(status: string): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}
