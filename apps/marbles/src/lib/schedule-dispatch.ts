import {
  DispatchError,
  type DispatchRequest,
  type DispatchStatus,
  ScheduleDispatch,
} from "@foundry/scheduling";
import { Effect, Layer, Logger } from "effect";
import type { Launched } from "~/lib/launcher";
import type { ScheduledEngine } from "~/lib/schedule";
import {
  outcomeOf,
  pendingOf,
  startPending,
  startScheduled,
} from "~/lib/schedule";
import type { Schedule } from "~/lib/triggers";

const REFUSED = /^refused-(\d+)-/;

const refusedJob = (key: string) => `refused-${String(Date.now())}-${key}`;

export function refusedAt(jobId: string): number | undefined {
  const at = REFUSED.exec(jobId)?.[1];
  return at === undefined ? undefined : Number(at);
}

export interface DispatcherOptions {
  readonly cancel: AbortSignal;
  readonly letGo?: AbortSignal;
  readonly print: (line: string) => void;
}

interface Followed {
  ended: boolean;
  failed: boolean;
}

const dispatchEffect = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new DispatchError({ cause }),
    try: call,
  });

const logLine = (message: unknown): string =>
  (Array.isArray(message) ? message : [message]).map(String).join(" ");

export class ScheduleDispatcher {
  readonly #engine: ScheduledEngine;
  readonly #options: DispatcherOptions;
  readonly #followed = new Map<string, Followed>();
  readonly #open = new Map<string, Promise<unknown>>();
  readonly #jobs = new Map<string, string>();
  readonly #stopping = new AbortController();

  constructor(engine: ScheduledEngine, options: DispatcherOptions) {
    this.#engine = engine;
    this.#options = options;
    options.cancel.addEventListener("abort", () => this.#cancelOpen(), {
      once: true,
    });
  }

  get layer(): Layer.Layer<ScheduleDispatch> {
    const { print } = this.#options;
    return Layer.merge(
      Layer.succeed(
        ScheduleDispatch,
        ScheduleDispatch.of({
          cancel: (jobId) => dispatchEffect(() => this.#cancel(jobId)),
          status: (jobId) => dispatchEffect(() => this.#status(jobId)),
          submit: (request) => dispatchEffect(() => this.#dispatch(request)),
        })
      ),
      Logger.replace(
        Logger.defaultLogger,
        Logger.make(({ message }) => print(`[schedule] ${logLine(message)}`))
      )
    );
  }

  stop(): void {
    this.#stopping.abort();
  }

  async drain(): Promise<void> {
    this.stop();
    const { letGo } = this.#options;
    const released = Promise.withResolvers<void>();
    const release = () => released.resolve();
    letGo?.addEventListener("abort", release, { once: true });
    try {
      while (this.#open.size > 0 && letGo?.aborted !== true) {
        await Promise.race([
          Promise.allSettled([...this.#open.values()]),
          released.promise,
        ]);
      }
    } finally {
      letGo?.removeEventListener("abort", release);
    }
  }

  async #dispatch({
    idempotencyKey,
    scheduleId,
  }: DispatchRequest): Promise<{ readonly jobId: string }> {
    const known = this.#jobs.get(idempotencyKey);
    if (known !== undefined) {
      return { jobId: known };
    }
    const schedule = await this.#live(scheduleId);
    const { print } = this.#options;
    print(`[schedule] ${schedule.key} → ${schedule.workflow}`);
    let started: Launched<unknown>;
    try {
      started = await startScheduled(this.#engine, schedule);
    } catch (error) {
      print(`[schedule] ${schedule.key} failed: ${String(error)}`);
      return this.#remember(idempotencyKey, refusedJob(idempotencyKey));
    }
    this.#follow(schedule, started);
    return this.#remember(idempotencyKey, started.id);
  }

  #remember(key: string, jobId: string): { readonly jobId: string } {
    this.#jobs.set(key, jobId);
    return { jobId };
  }

  #forget(jobId: string): void {
    this.#followed.delete(jobId);
    for (const [key, known] of this.#jobs) {
      if (known === jobId) {
        this.#jobs.delete(key);
      }
    }
  }

  async #live(scheduleId: string): Promise<Schedule> {
    this.#refuseWhenStopped();
    const schedule = (await this.#engine.schedules()).find(
      (candidate) => candidate.key === scheduleId
    );
    if (schedule === undefined) {
      throw new Error(`"${scheduleId}" is no longer scheduled`);
    }
    this.#refuseWhenStopped();
    return schedule;
  }

  #refuseWhenStopped(): void {
    if (this.#stopping.signal.aborted) {
      throw new Error("the schedule loop is stopping");
    }
  }

  #follow(schedule: Schedule, started: Launched<unknown>): void {
    const followed: Followed = { ended: false, failed: false };
    this.#followed.set(started.id, followed);
    const done = (async () => {
      try {
        const launch = pendingOf(schedule, await started.result);
        if (launch !== undefined && !this.#stopping.signal.aborted) {
          const target = await startPending(this.#engine, schedule.key, launch);
          this.#track(target.id, target.result);
        }
      } catch (error) {
        followed.failed = true;
        this.#options.print(
          `[schedule] ${schedule.key} failed: ${String(error)}`
        );
      } finally {
        followed.ended = true;
      }
    })();
    this.#track(started.id, done);
  }

  #track(id: string, ending: Promise<unknown>): void {
    const settled = ending.then(
      () => undefined,
      () => undefined
    );
    this.#open.set(id, settled);
    settled.finally(() => this.#open.delete(id)).catch(() => undefined);
    if (this.#options.cancel.aborted) {
      this.#cancelOpen();
    }
  }

  #cancelOpen(): void {
    for (const id of this.#open.keys()) {
      this.#engine.cancel(id).catch(() => undefined);
    }
  }

  async #status(jobId: string): Promise<DispatchStatus> {
    const refused = refusedAt(jobId);
    if (refused !== undefined) {
      this.#forget(jobId);
      return { kind: "settled", outcome: "failed", settledAt: refused };
    }
    const followed = this.#followed.get(jobId);
    if (followed?.ended === false) {
      return { kind: "open" };
    }
    const run = await this.#engine.executions.peek(jobId);
    if (run === undefined) {
      this.#forget(jobId);
      return { kind: "settled", outcome: "cancelled", settledAt: Date.now() };
    }
    const outcome = outcomeOf(run.status);
    if (outcome === undefined) {
      return { kind: "open" };
    }
    this.#forget(jobId);
    return {
      kind: "settled",
      outcome: followed?.failed === true ? "failed" : outcome,
      settledAt: Date.parse(
        run.timestamps.settledAt ?? run.timestamps.updatedAt
      ),
    };
  }

  async #cancel(jobId: string): Promise<void> {
    if (refusedAt(jobId) === undefined) {
      await this.#engine.cancel(jobId);
    }
  }
}
