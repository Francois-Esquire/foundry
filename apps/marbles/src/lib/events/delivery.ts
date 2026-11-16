import { AsyncLocalStorage } from "node:async_hooks";
import type { LoggedChange, MoveOutcome, ObserverKey } from "~/lib/events/log";
import { CHANGE_BATCH } from "~/lib/events/log";
import type { WorkspaceRecords } from "~/lib/events/records";
import type { Fact, Handler, Source } from "~/lib/events/source";
import { sourceKey } from "~/lib/events/source";
import type { ExecutionContext } from "~/lib/execution-context";
import { inContext } from "~/lib/execution-context";
import { current } from "~/lib/run-scope";

export const DELIVERY_POLL_MS = 1000;

const CHANGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const COMPACTION_EVERY_MS = 10 * 60 * 1000;

const HANDLER_TIMEOUT_MS = 5 * 60 * 1000;

const STOP_GRACE_MS = 10 * 1000;

const LONGEST_RETRY_MS = 5 * 60 * 1000;
const FIRST_RETRY_MS = 1000;

export function retryDelay(failures: number): number {
  return Math.min(
    FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1),
    LONGEST_RETRY_MS
  );
}

export interface DeliveryClock {
  after(ms: number): { readonly done: Promise<void>; cancel(): void };
  every(ms: number, tick: () => void): { cancel(): void };
  now(): number;
}

const WALL_CLOCK: DeliveryClock = {
  after(ms) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
    return { cancel: () => clearTimeout(timer), done };
  },
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    timer.unref?.();
    return { cancel: () => clearInterval(timer) };
  },
  now: () => Date.now(),
};

export interface ObserveOptions {
  readonly name: string;
  readonly timeout?: number | undefined;
  readonly types?: readonly string[];
}

interface Observer {
  call: { readonly since: number; readonly settled: Promise<void> } | undefined;
  failures: number;
  readonly handler: Handler<unknown>;
  readonly key: ObserverKey;
  lane: Promise<void> | undefined;
  position: number;
  retryAt: number | null;
  readonly timeout: number;
  readonly types: readonly string[] | undefined;
}

export interface DeliveryOptions {
  readonly clock?: DeliveryClock;
  readonly compactionStep?: number | undefined;
  readonly context?: ExecutionContext;
  readonly handlerTimeout?: number | undefined;
  readonly print: (line: string) => void;
  readonly records: WorkspaceRecords;
  readonly retention?: number | undefined;
  readonly stopGrace?: number | undefined;
}

type Outcome =
  | { readonly kind: "completed" }
  | { readonly error: unknown; readonly kind: "threw" }
  | { readonly kind: "timed out" }
  | { readonly kind: "abandoned" };

export class Delivery {
  readonly #observers: Observer[] = [];
  readonly #context: ExecutionContext | undefined;
  readonly #records: WorkspaceRecords;
  readonly #print: (line: string) => void;
  readonly #clock: DeliveryClock;
  readonly #retention: number;
  readonly #compactionStep: number | undefined;
  readonly #handlerTimeout: number;
  readonly #stopGrace: number;
  #claimed = false;
  #claiming: Promise<void> | undefined;
  #phase:
    | "new"
    | "starting"
    | "waiting"
    | "running"
    | "compacting"
    | "stopped" = "new";
  #pass: Promise<void> | undefined;
  #again = false;
  readonly #abandon = new Set<() => void>();
  readonly #stopped: { gaveUp: boolean } = { gaveUp: false };
  #timer: { cancel(): void } | undefined;
  #compactTimer: { cancel(): void } | undefined;
  #compacting: Promise<void> | undefined;
  #compactionProblem: string | undefined;
  #problem: string | undefined;
  /** Runs a pass in the context this delivery was built in; see above. */
  readonly #built = AsyncLocalStorage.snapshot();

  constructor(options: DeliveryOptions) {
    this.#records = options.records;
    this.#print = options.print;
    this.#context = options.context;
    this.#clock = options.clock ?? WALL_CLOCK;
    this.#retention = options.retention ?? CHANGE_RETENTION_MS;
    this.#compactionStep = options.compactionStep;
    this.#handlerTimeout = options.handlerTimeout ?? HANDLER_TIMEOUT_MS;
    this.#stopGrace = options.stopGrace ?? STOP_GRACE_MS;
  }

  observe<T extends Fact>(
    source: Source<T>,
    handler: Handler<T>,
    options: ObserveOptions
  ): void {
    const key = sourceKey(source);
    if (key === undefined) {
      throw new TypeError("observe: the source is not something Marbles emits");
    }
    const name = options.name.trim();
    if (name === "") {
      throw new TypeError("observe: an observer's name cannot be blank");
    }
    if (
      options.timeout !== undefined &&
      !(Number.isFinite(options.timeout) && options.timeout > 0)
    ) {
      throw new TypeError(
        "observe: an observer's timeout is a number of ms above 0"
      );
    }
    if (
      this.#observers.some(
        (observer) => observer.key.source === key && observer.key.name === name
      )
    ) {
      throw new Error(
        `observe: an observer of ${key} named "${name}" is already declared in this workspace; give each its own name`
      );
    }
    this.#observers.push({
      call: undefined,
      failures: 0,
      handler: handler as Handler<unknown>,
      key: { name, source: key },
      lane: undefined,
      position: 0,
      retryAt: null,
      timeout: options.timeout ?? this.#handlerTimeout,
      types: options.types === undefined ? undefined : [...options.types],
    });
  }

  async start(): Promise<void> {
    if (this.#phase !== "new") {
      return;
    }
    if (this.#observers.length === 0) {
      this.#phase = "compacting";
      this.#compactEvery();
      return;
    }
    this.#phase = "starting";
    await this.#declare();
    this.#compactEvery();
    const holder = await this.#claim();
    if (this.#phase !== "starting") {
      await this.#release();
      return;
    }
    if (holder !== undefined) {
      this.#print(
        `[observe] not delivering here: the changes of this workspace are delivered by ${holder}; delivering here once it stops`
      );
      this.#phase = "waiting";
      this.#tickEvery();
      return;
    }
    try {
      await this.#takeOver();
    } catch (error) {
      await this.#release();
      throw error;
    }
    if (this.#phase !== "starting") {
      await this.#release();
      return;
    }
    this.#phase = "running";
    this.#tickEvery();
    this.wake();
  }

  /** Begin a pass, or another after the one in progress. */
  wake(): void {
    if (this.#phase !== "running") {
      return;
    }
    if (this.#pass !== undefined) {
      this.#again = true;
      return;
    }
    this.#again = false;
    this.#pass = this.#built(() =>
      current.exit(() => {
        const context = this.#context;
        return context === undefined
          ? this.#run()
          : inContext(context, () => this.#run());
      })
    );
  }

  async idle(): Promise<void> {
    for (;;) {
      const running = [
        this.#pass,
        this.#compacting,
        ...this.#observers.map((observer) => observer.lane),
      ].filter((work) => work !== undefined);
      if (running.length === 0) {
        return;
      }
      await Promise.allSettled(running);
    }
  }

  async stop(): Promise<void> {
    this.#phase = "stopped";
    this.#timer?.cancel();
    this.#timer = undefined;
    this.#compactTimer?.cancel();
    this.#compactTimer = undefined;
    try {
      await this.#pass;
      await this.#claiming;
      await this.#compacting;
      const lanes = this.#observers
        .map((observer) => observer.lane)
        .filter((lane) => lane !== undefined);
      if (lanes.length > 0) {
        const grace = this.#clock.after(this.#stopGrace);
        await Promise.race([Promise.allSettled(lanes), grace.done]);
        grace.cancel();
      }
    } finally {
      this.#stopped.gaveUp = true;
      for (const abandon of this.#abandon) {
        abandon();
      }
      await this.#release();
    }
  }

  async #declare(): Promise<void> {
    for (const observer of this.#observers) {
      await this.#declareOne(observer);
    }
  }

  async #declareOne(observer: Observer): Promise<void> {
    const state = await this.#records.log.declare(
      observer.key,
      this.#clock.now()
    );
    observer.position = state.position;
    observer.failures = state.failures;
    observer.retryAt = state.retryAt;
  }

  async #takeOver(): Promise<void> {
    for (const observer of this.#observers) {
      if (!(await this.#records.log.unstick(observer.key))) {
        this.#dropped(observer, "clearing what a gone deliverer left stuck");
      }
    }
  }

  #dropped(observer: Observer, what: string): void {
    this.#print(
      `[observe] ${describe(observer.key)}: not ${what}: this engine no longer delivers this workspace's changes`
    );
  }

  async #claim(): Promise<string | undefined> {
    const holder = await this.#records.claimDelivery();
    if (holder === undefined) {
      this.#claimed = true;
    }
    return holder;
  }

  async #release(): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; a claim sets it.
    if (this.#claimed) {
      await this.#records.releaseDelivery();
      this.#claimed = false;
    }
  }

  #tickEvery(): void {
    this.#timer = this.#clock.every(DELIVERY_POLL_MS, () => {
      this.#tick();
    });
  }

  #tick(): void {
    if (this.#phase === "running") {
      this.wake();
      return;
    }
    if (this.#phase !== "waiting" || this.#claiming !== undefined) {
      return;
    }
    this.#claiming = this.#claimWaiting().finally(() => {
      this.#claiming = undefined;
    });
  }

  async #claimWaiting(): Promise<void> {
    let holder: string | undefined;
    try {
      holder = await this.#claim();
      if (holder !== undefined) {
        return;
      }
      await this.#declare();
      await this.#takeOver();
    } catch (error) {
      this.#report(error);
      return;
    }
    if (this.#phase !== "waiting") {
      return;
    }
    this.#print("[observe] delivering here: the engine that delivered let go");
    this.#phase = "running";
    this.wake();
  }

  #takeAgain(): boolean {
    const again = this.#again;
    this.#again = false;
    return again;
  }

  #report(error: unknown): void {
    const line = `[observe] ${String(error)}`;
    if (line !== this.#problem) {
      this.#problem = line;
      this.#print(line);
    }
  }

  async #run(): Promise<void> {
    try {
      do {
        try {
          await this.#startDue();
          this.#problem = undefined;
        } catch (error) {
          this.#report(error);
        }
      } while (this.#takeAgain() && this.#phase === "running");
    } finally {
      this.#pass = undefined;
    }
  }

  async #startDue(): Promise<void> {
    const head = await this.#records.log.head();
    const now = this.#clock.now();
    for (const observer of this.#observers) {
      if (this.#phase !== "running") {
        return;
      }
      if (
        observer.lane !== undefined ||
        observer.call !== undefined ||
        observer.position >= head ||
        (observer.retryAt !== null && observer.retryAt > now)
      ) {
        continue;
      }
      observer.lane = this.#lane(observer, head);
    }
  }

  async #lane(observer: Observer, head: number): Promise<void> {
    let caughtUp = false;
    try {
      caughtUp = await this.#catchUp(observer, head);
    } catch (error) {
      this.#report(error);
    } finally {
      observer.lane = undefined;
    }
    if (caughtUp) {
      this.wake();
    }
  }

  #compactEvery(): void {
    const interval = Math.min(
      COMPACTION_EVERY_MS,
      Math.max(1, Math.floor(this.#retention / 2))
    );
    this.#compactTimer = this.#clock.every(interval, () => {
      this.#compactSoon();
    });
    this.#compactSoon();
  }

  #compactSoon(): void {
    if (this.#compacting !== undefined || this.#phase === "stopped") {
      return;
    }
    this.#compacting = this.#built(() =>
      current.exit(() => this.#compact())
    ).finally(() => {
      this.#compacting = undefined;
    });
  }

  async #compact(): Promise<void> {
    try {
      for (;;) {
        const now = this.#clock.now();
        const bound = now - this.#retention;
        const step = await this.#records.log.compact({
          before: bound,
          ...(this.#compactionStep === undefined
            ? {}
            : { limit: this.#compactionStep }),
          now,
          registered: this.#observers.map((observer) => observer.key),
          seenSince: bound,
        });
        if (step.done || this.#phase === "stopped") {
          this.#compactionProblem = undefined;
          return;
        }
        await new Promise<void>((resume) => setImmediate(resume));
      }
    } catch (error) {
      const line = `[observe] compaction: ${String(error)}`;
      if (line !== this.#compactionProblem) {
        this.#compactionProblem = line;
        this.#print(line);
      }
    }
  }

  async #catchUp(observer: Observer, head: number): Promise<boolean> {
    for (;;) {
      const batch = await this.#records.log.read({
        after: observer.position,
        limit: CHANGE_BATCH,
        source: observer.key.source,
        ...(observer.types === undefined ? {} : { types: observer.types }),
      });
      for (const change of batch) {
        if (change.position > head) {
          return (
            observer.position >= head || (await this.#moveTo(observer, head))
          );
        }
        if (this.#phase !== "running") {
          return false;
        }
        if (!(await this.#hand(observer, change))) {
          return false;
        }
      }
      if (batch.length < CHANGE_BATCH) {
        break;
      }
    }
    return observer.position >= head || (await this.#moveTo(observer, head));
  }

  async #hand(observer: Observer, change: LoggedChange): Promise<boolean> {
    const outcome = await this.#call(observer, change);
    switch (outcome.kind) {
      case "abandoned":
        return false;
      case "threw":
        await this.#failed(
          observer,
          change,
          describeError(outcome.error),
          null
        );
        return false;
      case "timed out":
        await this.#failed(
          observer,
          change,
          `the handler did not finish within ${seconds(observer.timeout)}`,
          observer.call?.since ?? null
        );
        return false;
      default:
        return await this.#moveTo(observer, change.position, change);
    }
  }

  async #call(observer: Observer, change: LoggedChange): Promise<Outcome> {
    // Each handler gets its own copy: one cannot change what another sees.
    const fact = structuredClone(change.fact);
    const settled: Promise<Outcome> = Promise.resolve()
      .then(() => observer.handler(fact))
      .then(
        () => ({ kind: "completed" }),
        (error: unknown) => ({ error, kind: "threw" })
      );
    observer.call = {
      settled: settled.then(() => undefined),
      since: this.#clock.now(),
    };
    const limit = this.#clock.after(observer.timeout);
    const abandoned = Promise.withResolvers<Outcome>();
    const abandon = () => abandoned.resolve({ kind: "abandoned" });
    this.#abandon.add(abandon);
    if (this.#stopped.gaveUp) {
      abandon();
    }
    const outcome = await Promise.race([
      settled,
      limit.done.then((): Outcome => ({ kind: "timed out" })),
      abandoned.promise,
    ]);
    this.#abandon.delete(abandon);
    limit.cancel();
    if (outcome.kind === "timed out") {
      settled.then(() => this.#unstuck(observer));
      return outcome;
    }
    observer.call = undefined;
    return this.#stopped.gaveUp ? { kind: "abandoned" } : outcome;
  }

  async #unstuck(observer: Observer): Promise<void> {
    observer.call = undefined;
    if (this.#stopped.gaveUp) {
      return;
    }
    try {
      if (!(await this.#records.log.unstick(observer.key))) {
        this.#dropped(observer, "clearing its stuck mark");
        return;
      }
    } catch (error) {
      this.#report(error);
    }
    this.wake();
  }

  async #moveTo(
    observer: Observer,
    to: number,
    completed?: LoggedChange
  ): Promise<boolean> {
    if (this.#stopped.gaveUp) {
      return false;
    }
    let moved: MoveOutcome;
    try {
      moved = await this.#records.log.move(observer.key, {
        from: observer.position,
        handed: completed !== undefined,
        now: this.#clock.now(),
        to,
      });
    } catch (error) {
      if (completed !== undefined) {
        this.#print(
          `[observe] ${describe(observer.key)} completed ${completed.fact.type} ${String(completed.position)}, but that was not saved and it may run again: ${String(error)}`
        );
      }
      return false;
    }
    if (moved.kind === "unclaimed") {
      this.#dropped(observer, "moving its place");
      return false;
    }
    if (moved.kind === "elsewhere") {
      await this.#declareOne(observer);
      return false;
    }
    if (moved.missed !== null) {
      this.#print(
        `[observe] ${describe(observer.key)} missed changes ${String(moved.missed.from)} to ${String(moved.missed.through)}: they were removed before it received them; it goes on after them`
      );
    }
    observer.position = to;
    observer.failures = 0;
    observer.retryAt = null;
    return true;
  }

  async #failed(
    observer: Observer,
    change: LoggedChange,
    message: string,
    stuckSince: number | null
  ): Promise<void> {
    if (this.#stopped.gaveUp) {
      return;
    }
    const failures = observer.failures + 1;
    const delay = retryDelay(failures);
    const now = this.#clock.now();
    observer.failures = failures;
    observer.retryAt = now + delay;
    this.#print(
      `[observe] ${describe(observer.key)} failed on ${change.fact.type} ${String(change.position)} (failure ${String(failures)}; trying again in ${seconds(delay)}${stuckSince === null ? "" : ", once this call settles"}): ${message}`
    );
    try {
      const written = await this.#records.log.fail(observer.key, {
        error: message,
        now,
        retryAt: observer.retryAt,
        stuckSince,
      });
      if (!written) {
        this.#dropped(observer, "recording its failure");
      }
    } catch (saving) {
      this.#report(saving);
    }
  }
}

function describe(key: ObserverKey): string {
  return `${key.name} (${key.source})`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(ms: number): string {
  return `${String(Math.round(ms / 1000))}s`;
}
