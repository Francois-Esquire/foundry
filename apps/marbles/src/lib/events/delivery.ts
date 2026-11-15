import { AsyncLocalStorage } from "node:async_hooks";
import type { LoggedChange, MoveOutcome, ObserverKey } from "~/lib/events/log";
import { CHANGE_BATCH } from "~/lib/events/log";
import type { WorkspaceRecords } from "~/lib/events/records";
import type { Fact, Handler, Source } from "~/lib/events/source";
import { sourceKey } from "~/lib/events/source";
import type { ExecutionContext } from "~/lib/execution-context";
import { inContext } from "~/lib/execution-context";
import { current } from "~/lib/run-scope";

/**
 * Hands each fact in a workspace's change log to every observer of its
 * source, in the order the facts were committed, and keeps each observer's
 * place in the log (`ChangeLog`).
 *
 * An observer is known by its workspace, its source and its name, never by
 * its handler's code: an edit to a handler keeps its place, a rename makes
 * a new observer, and a new observer starts from now. Its place is filed
 * when an engine declaring it starts, whether or not that engine delivers.
 *
 * Delivery is at least once. An observer's place moves past a fact only
 * once its handler completed it, and only from the place it was handed
 * the fact at, so a move another deliverer made first is never undone; a
 * handler that completed but whose move could not be saved is handed the
 * fact again. A fact of another type than the observer asked for is passed
 * over, its place moved past it.
 *
 * Observers are delivered to independently: each has a lane of its own,
 * one handler call at a time, outside any write, so one observer being
 * slow, failing or hung never delays another. A pass reads the counter
 * once and starts the lane of each observer that is behind it and due; a
 * lane hands its observer the facts up to that counter and no further, so
 * a handler that writes to the source it observes cannot keep one lane
 * going for ever. A handler that throws, or does not finish within its
 * time limit (`HANDLER_TIMEOUT_MS`, or the observer's own), keeps its
 * place, and is tried again after a backoff that doubles with each
 * failure in a row (`retryDelay`); its failures, its last error and when
 * it is tried next are kept with its place, for `marbles status`. A call
 * past its limit is not abandoned to another: until it settles, the
 * observer is stuck in it (kept with its place, since when) and handed
 * nothing, and its retry waits for it.
 *
 * Facts every observer registered here, or seen within the retention, has
 * completed, and that committed longer ago than the retention, are removed
 * (`compact`), at most once per `COMPACTION_EVERY_MS`: an observer this
 * engine has registered holds them back however long it is idle, in
 * backoff or stuck. A place never moves over a gap in silence: a move past
 * positions compaction removed records them as missed in the same write,
 * and the observer is told so, once, then goes on after them.
 *
 * Every write about an observer is made only while this delivery's
 * records hold the claim; one refused because they no longer do is
 * printed and dropped, never retried.
 *
 * One engine delivers a workspace's changes at a time: the one granted the
 * claim (`DeliveryLease`), from a successful start until `stop`. Any
 * number of processes write the workspace's records. The deliverer is
 * woken at once by a commit made in its own process, and notices one made
 * elsewhere within `DELIVERY_POLL_MS`, the tick that also retries failed
 * observers. A process refused the claim tries again on the same tick, and
 * takes up each observer at the place the last deliverer left it. `stop`
 * waits for the handler calls in flight for `STOP_GRACE_MS` at most, then
 * gives the claim up without them: the place of an observer whose call
 * did not finish is not moved, so its fact is delivered again later.
 *
 * A pass never runs inside a run. A write inside a step body wakes
 * delivery, and a pass started there would otherwise inherit that step's
 * frame: a definition a handler calls would join the writer's run as a
 * dynamic child instead of starting a run of its own. So a pass runs in
 * the async context this delivery was built in, not the waker's (which
 * also keeps a host's per-call output capture out of it), with no run
 * frame, as the engine's workspace (`context`).
 */

/**
 * How often, in ms, a running delivery looks for facts another process
 * recorded (one cheap read: the counter) and retries the observers whose
 * backoff is over, and a delivery another process holds tries to claim it.
 */
export const DELIVERY_POLL_MS = 1000;

/** How long, in ms, the log keeps facts every observer has completed: a week. */
const CHANGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How often, in ms, a running delivery compacts the log: every ten minutes. */
const COMPACTION_EVERY_MS = 10 * 60 * 1000;

/** How long, in ms, a handler call may run before it counts as failed: five minutes. */
const HANDLER_TIMEOUT_MS = 5 * 60 * 1000;

/** How long, in ms, `stop` waits for the handler calls in flight: ten seconds. */
const STOP_GRACE_MS = 10 * 1000;

/** The longest a failing observer waits to be tried again, in ms. */
const LONGEST_RETRY_MS = 5 * 60 * 1000;
const FIRST_RETRY_MS = 1000;

/** How long an observer that failed `failures` times in a row waits to be tried again, in ms. */
export function retryDelay(failures: number): number {
  return Math.min(
    FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1),
    LONGEST_RETRY_MS
  );
}

/**
 * The time delivery goes by: what time it is, in epoch ms, and a wait that
 * ends after a while, or never once cancelled. A test hands in one it
 * moves itself.
 */
export interface DeliveryClock {
  after(ms: number): { readonly done: Promise<void>; cancel(): void };
  /** Call `tick` every `ms` until cancelled. */
  every(ms: number, tick: () => void): { cancel(): void };
  now(): number;
}

/** The wall clock, its waits keeping no process alive. */
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

/** How an observer is declared, beside its source and handler. */
export interface ObserveOptions {
  /** Its name within the workspace and source: its identity. */
  readonly name: string;
  /** How long, in ms, one call of its handler may run; the delivery's limit when omitted. */
  readonly timeout?: number | undefined;
  /** Only facts of these types; every type of the source when omitted. */
  readonly types?: readonly string[];
}

interface Observer {
  /** The handler call in flight, and when it began. */
  call: { readonly since: number; readonly settled: Promise<void> } | undefined;
  /** Failures in a row, as last filed. */
  failures: number;
  readonly handler: Handler<unknown>;
  readonly key: ObserverKey;
  /** Its lane, while one runs. */
  lane: Promise<void> | undefined;
  /** The last position it completed or passed over, as last filed. */
  position: number;
  /** When it is tried again, in epoch ms; `null` while it is well. */
  retryAt: number | null;
  /** How long one call may run, in ms. */
  readonly timeout: number;
  readonly types: readonly string[] | undefined;
}

export interface DeliveryOptions {
  /** The time delivery goes by; the wall clock when omitted. */
  readonly clock?: DeliveryClock;
  /** What every handler runs as: the engine's workspace, outside any run. */
  readonly context?: ExecutionContext;
  /** How long, in ms, one handler call may run; `HANDLER_TIMEOUT_MS` when omitted. */
  readonly handlerTimeout?: number | undefined;
  readonly print: (line: string) => void;
  /** The workspace's records: its change log, and who delivers it. */
  readonly records: WorkspaceRecords;
  /** How long facts every observer completed are kept, in ms; `CHANGE_RETENTION_MS` when omitted. */
  readonly retention?: number | undefined;
  /** How long `stop` waits for handler calls in flight, in ms; `STOP_GRACE_MS` when omitted. */
  readonly stopGrace?: number | undefined;
}

/** How one handler call ended. */
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
  readonly #handlerTimeout: number;
  readonly #stopGrace: number;
  /** Whether this delivery holds the claim, so `stop` gives it up. */
  #claimed = false;
  /** A tick's claim under way, so the next tick does not start another. */
  #claiming: Promise<void> | undefined;
  /** `waiting`: another process delivers here; this one tries to claim it on each tick. */
  /** `starting`: `start` is under way; a `stop` meanwhile ends it, and it gives up any claim it took. */
  #phase: "new" | "starting" | "waiting" | "running" | "stopped" = "new";
  #pass: Promise<void> | undefined;
  /** A wake came while a pass ran: look again once it ends. */
  #again = false;
  /**
   * Settled once `stop` stops waiting for the calls in flight: from then
   * no lane moves a place or files a failure, since the claim is given up.
   */
  /**
   * What tells each handler call in flight that `stop` gave up waiting. A
   * call takes its own entry out when it is over, so a host that runs for
   * months holds one per call in flight and none per fact delivered.
   */
  readonly #abandon = new Set<() => void>();
  readonly #stopped: { gaveUp: boolean } = { gaveUp: false };
  /** When the log was last compacted here, in epoch ms; never, at first. */
  #compactedAt = Number.NEGATIVE_INFINITY;
  #timer: { cancel(): void } | undefined;
  /** The last problem a tick printed, so a lasting one is printed once. */
  #problem: string | undefined;
  /** Runs a pass in the context this delivery was built in; see above. */
  readonly #built = AsyncLocalStorage.snapshot();

  constructor(options: DeliveryOptions) {
    this.#records = options.records;
    this.#print = options.print;
    this.#context = options.context;
    this.#clock = options.clock ?? WALL_CLOCK;
    this.#retention = options.retention ?? CHANGE_RETENTION_MS;
    this.#handlerTimeout = options.handlerTimeout ?? HANDLER_TIMEOUT_MS;
    this.#stopGrace = options.stopGrace ?? STOP_GRACE_MS;
  }

  /**
   * Follow `source` with `handler`, as the observer `options.name`, from
   * the next start. A name already declared for the source is refused.
   */
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
      // A source emits only its own fact type.
      handler: handler as Handler<unknown>,
      key: { name, source: key },
      lane: undefined,
      position: 0,
      retryAt: null,
      timeout: options.timeout ?? this.#handlerTimeout,
      types: options.types === undefined ? undefined : [...options.types],
    });
  }

  /**
   * File every observer's place (from now, for a new one), then claim
   * delivery. Without observers nothing is filed or claimed. Delivery
   * another process has claimed is left to it, and claimed here once it
   * lets go (or exits), on a later tick; a log that cannot be read fails
   * the start.
   */
  async start(): Promise<void> {
    if (this.#phase !== "new" || this.#observers.length === 0) {
      return;
    }
    this.#phase = "starting";
    await this.#declare();
    const holder = await this.#claim();
    // After every wait: stopped meanwhile, this never runs, and gives up
    // the claim a `stop` before it was granted found no claim to give up.
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

  /**
   * Resolves once no pass and no lane runs here: what a wake started has
   * been handed out, or has failed. A call stuck past its limit does not
   * count; its lane has ended.
   */
  async idle(): Promise<void> {
    for (;;) {
      const running = [
        this.#pass,
        ...this.#observers.map((observer) => observer.lane),
      ].filter((work) => work !== undefined);
      if (running.length === 0) {
        return;
      }
      await Promise.allSettled(running);
    }
  }

  /**
   * Start no handler again; wait for those in flight for the grace at
   * most, then give up the claim without them, their places unmoved.
   */
  async stop(): Promise<void> {
    this.#phase = "stopped";
    this.#timer?.cancel();
    this.#timer = undefined;
    try {
      await this.#pass;
      await this.#claiming;
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

  /** Read every observer's place as filed, filing it at the counter when it is new. */
  async #declare(): Promise<void> {
    for (const observer of this.#observers) {
      await this.#declareOne(observer);
    }
  }

  /** Read `observer`'s place as filed. */
  async #declareOne(observer: Observer): Promise<void> {
    const state = await this.#records.log.declare(
      observer.key,
      this.#clock.now()
    );
    observer.position = state.position;
    observer.failures = state.failures;
    observer.retryAt = state.retryAt;
  }

  /**
   * Now this delivery holds the claim: no observer is stuck in a call of
   * a deliverer that let go or is gone, whatever it filed.
   */
  async #takeOver(): Promise<void> {
    for (const observer of this.#observers) {
      if (!(await this.#records.log.unstick(observer.key))) {
        this.#dropped(observer, "clearing what a gone deliverer left stuck");
      }
    }
  }

  /** Say that a write about `observer` was refused, these records no longer holding the claim; it is not tried again. */
  #dropped(observer: Observer, what: string): void {
    this.#print(
      `[observe] ${describe(observer.key)}: not ${what}: this engine no longer delivers this workspace's changes`
    );
  }

  /** Take the claim; who holds it instead, when another engine does. */
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
      // Held until the release has landed: one that fails is tried again
      // by the next release, `stop`'s or the records' own on close.
      await this.#records.releaseDelivery();
      this.#claimed = false;
    }
  }

  /** Tick on `DELIVERY_POLL_MS`, by the clock, without keeping the process alive. */
  #tickEvery(): void {
    this.#timer = this.#clock.every(DELIVERY_POLL_MS, () => {
      this.#tick();
    });
  }

  /** Claim delivery when waiting; when running, wake to look for facts recorded elsewhere and retries due. */
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

  /** One tick's try at the claim another engine held. */
  async #claimWaiting(): Promise<void> {
    let holder: string | undefined;
    try {
      holder = await this.#claim();
      if (holder !== undefined) {
        return;
      }
      // The places the engine that let go left them at.
      await this.#declare();
      await this.#takeOver();
    } catch (error) {
      this.#report(error);
      return;
    }
    if (this.#phase !== "waiting") {
      // Stopped while it was claimed: `stop` gives it up.
      return;
    }
    this.#print("[observe] delivering here: the engine that delivered let go");
    this.#phase = "running";
    this.wake();
  }

  /** Whether a wake came since this was last asked, and forget it. */
  #takeAgain(): boolean {
    const again = this.#again;
    this.#again = false;
    return again;
  }

  /** Print a problem a tick or a pass met, once while it lasts. */
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
      // In the same turn as the last check, so a wake from here on starts a pass.
      this.#pass = undefined;
    }
  }

  /**
   * One pass: compact when due, then start the lane of each observer that
   * is behind the counter as it reads now, and due, up to that counter.
   */
  async #startDue(): Promise<void> {
    const head = await this.#records.log.head();
    await this.#compactWhenDue();
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

  /** `observer`'s lane: its catch-up to `head`, then a look for more. */
  async #lane(observer: Observer, head: number): Promise<void> {
    let caughtUp = false;
    try {
      caughtUp = await this.#catchUp(observer, head);
    } catch (error) {
      this.#report(error);
    } finally {
      observer.lane = undefined;
    }
    // What was written while it ran is for the next pass, not this lane.
    if (caughtUp) {
      this.wake();
    }
  }

  async #compactWhenDue(): Promise<void> {
    const now = this.#clock.now();
    if (now - this.#compactedAt < COMPACTION_EVERY_MS) {
      return;
    }
    this.#compactedAt = now;
    const bound = now - this.#retention;
    // Every observer registered here holds facts back, whatever it is doing.
    await this.#records.log.compact({
      before: bound,
      now,
      registered: this.#observers.map((observer) => observer.key),
      seenSince: bound,
    });
  }

  /**
   * Hand `observer` each fact of its source after its place up to `head`,
   * and no further, then move it to `head` past any of other types:
   * whether it got there, rather than stopping at a failure, a move it
   * could not make, or a stop.
   */
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

  /** Hand `change` to `observer` and move it past; whether it may go on. */
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

  /**
   * Call `observer`'s handler with `change`, waiting for it no longer than
   * its time limit, nor once `stop` gave up waiting. A call past its limit
   * stays the observer's own until it settles: then the observer is no
   * longer stuck, and is looked at again.
   */
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

  /** `observer`'s call past its limit settled: hand it facts again, once its retry is due. */
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

  /**
   * Move `observer`'s filed place to `to` from where it was; whether it
   * moved. One another deliverer moved first is read again, and one that
   * could not be saved keeps its place here, so what it completed is
   * handed to it again.
   */
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
      // Another deliverer moved it: go on from where it is filed.
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

  /**
   * File `observer`'s failure on `change`, `stuckSince` when the call is
   * past its limit and still running, and when it is tried again.
   */
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

/** An observer as a line names it: `name (source)`. */
function describe(key: ObserverKey): string {
  return `${key.name} (${key.source})`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `ms` as a person reads it: whole seconds. */
function seconds(ms: number): string {
  return `${String(Math.round(ms / 1000))}s`;
}
