import { AsyncLocalStorage } from "node:async_hooks";
import type { LoggedChange, ObserverKey } from "~/lib/events/log";
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
 * Observers are handed facts one handler at a time, in declaration order,
 * outside any write. A handler that throws keeps its place, and is tried
 * again after a backoff that doubles with each failure in a row
 * (`retryDelay`), while the other observers go on; its failures, its last
 * error and when it is tried next are kept with its place, for `marbles
 * status`. An observer that fell behind what compaction removed is told
 * what it missed, once, and goes on after it.
 *
 * Facts every observer seen within the retention has completed, and that
 * committed longer ago than the retention, are removed (`compact`), at
 * most once per `COMPACTION_EVERY_MS`.
 *
 * One engine delivers a workspace's changes at a time: the one granted the
 * claim (`DeliveryLease`), from a successful start until `stop`. Any
 * number of processes write the workspace's records. The deliverer is
 * woken at once by a commit made in its own process, and notices one made
 * elsewhere within `DELIVERY_POLL_MS`, the tick that also retries failed
 * observers. A process refused the claim tries again on the same tick, and
 * takes up each observer at the place the last deliverer left it.
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

/** How an observer is declared, beside its source and handler. */
export interface ObserveOptions {
  /** Its name within the workspace and source: its identity. */
  readonly name: string;
  /** Only facts of these types; every type of the source when omitted. */
  readonly types?: readonly string[];
}

interface Observer {
  /** Failures in a row, as last filed. */
  failures: number;
  readonly handler: Handler<unknown>;
  readonly key: ObserverKey;
  /** The last position it completed or passed over, as last filed. */
  position: number;
  /** When it is tried again, in epoch ms; `null` while it is well. */
  retryAt: number | null;
  readonly types: readonly string[] | undefined;
}

export interface DeliveryOptions {
  /** What every handler runs as: the engine's workspace, outside any run. */
  readonly context?: ExecutionContext;
  /** The clock, in epoch ms; `Date.now` when omitted. */
  readonly now?: () => number;
  readonly print: (line: string) => void;
  /** The workspace's records: its change log, and who delivers it. */
  readonly records: WorkspaceRecords;
  /** How long facts every observer completed are kept, in ms; `CHANGE_RETENTION_MS` when omitted. */
  readonly retention?: number | undefined;
}

export class Delivery {
  readonly #observers: Observer[] = [];
  readonly #context: ExecutionContext | undefined;
  readonly #records: WorkspaceRecords;
  readonly #print: (line: string) => void;
  readonly #now: () => number;
  readonly #retention: number;
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
  /** When the log was last compacted here, in epoch ms; never, at first. */
  #compactedAt = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** The last problem a tick printed, so a lasting one is printed once. */
  #problem: string | undefined;
  /** Runs a pass in the context this delivery was built in; see above. */
  readonly #built = AsyncLocalStorage.snapshot();

  constructor(options: DeliveryOptions) {
    this.#records = options.records;
    this.#print = options.print;
    this.#context = options.context;
    this.#now = options.now ?? Date.now;
    this.#retention = options.retention ?? CHANGE_RETENTION_MS;
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
      this.#observers.some(
        (observer) => observer.key.source === key && observer.key.name === name
      )
    ) {
      throw new Error(
        `observe: an observer of ${key} named "${name}" is already declared in this workspace; give each its own name`
      );
    }
    this.#observers.push({
      failures: 0,
      // A source emits only its own fact type.
      handler: handler as Handler<unknown>,
      key: { name, source: key },
      position: 0,
      retryAt: null,
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

  /** Start no handler again; wait for the one running, then give up the claim. */
  async stop(): Promise<void> {
    this.#phase = "stopped";
    clearInterval(this.#timer);
    this.#timer = undefined;
    try {
      await this.#pass;
      await this.#claiming;
    } finally {
      await this.#release();
    }
  }

  /**
   * Read every observer's place as filed, filing it at the counter when it
   * is new, and tell of any that fell behind compaction.
   */
  async #declare(): Promise<void> {
    for (const observer of this.#observers) {
      const state = await this.#records.log.declare(observer.key, this.#now());
      observer.position = state.position;
      observer.failures = state.failures;
      observer.retryAt = state.retryAt;
      if (state.fellBehind && state.missed !== null) {
        this.#print(
          `[observe] ${describe(observer.key)} missed changes ${String(state.missed.from)} to ${String(state.missed.through)}: they were removed before it received them; it goes on after them`
        );
      }
    }
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

  /** Tick on `DELIVERY_POLL_MS`, without keeping the process alive. */
  #tickEvery(): void {
    this.#timer = setInterval(() => {
      this.#tick();
    }, DELIVERY_POLL_MS);
    this.#timer.unref?.();
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
          await this.#deliverAll();
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

  /** One pass: compact when due, then bring each observer that is due up to the counter. */
  async #deliverAll(): Promise<void> {
    const head = await this.#records.log.head();
    await this.#compactWhenDue();
    for (const observer of this.#observers) {
      if (this.#phase !== "running") {
        return;
      }
      const now = this.#now();
      if (
        observer.position >= head ||
        (observer.retryAt !== null && observer.retryAt > now)
      ) {
        continue;
      }
      await this.#catchUp(observer, head);
    }
  }

  async #compactWhenDue(): Promise<void> {
    const now = this.#now();
    if (now - this.#compactedAt < COMPACTION_EVERY_MS) {
      return;
    }
    this.#compactedAt = now;
    const bound = now - this.#retention;
    await this.#records.log.compact({ before: bound, seenSince: bound });
  }

  /**
   * Hand `observer` each fact of its source after its place, up to `head`
   * at least, then move it to `head` past any of other types; stop at its
   * first failure, or a move it could not make.
   */
  async #catchUp(observer: Observer, head: number): Promise<void> {
    for (;;) {
      const batch = await this.#records.log.read({
        after: observer.position,
        limit: CHANGE_BATCH,
        source: observer.key.source,
        ...(observer.types === undefined ? {} : { types: observer.types }),
      });
      for (const change of batch) {
        if (this.#phase !== "running") {
          return;
        }
        if (!(await this.#hand(observer, change))) {
          return;
        }
      }
      if (batch.length < CHANGE_BATCH) {
        break;
      }
    }
    if (observer.position < head) {
      await this.#moveTo(observer, head);
    }
  }

  /** Hand `change` to `observer` and move it past; whether it may go on. */
  async #hand(observer: Observer, change: LoggedChange): Promise<boolean> {
    try {
      // Each handler gets its own copy: one cannot change what another sees.
      await observer.handler(structuredClone(change.fact));
    } catch (error) {
      await this.#failed(observer, change, error);
      return false;
    }
    return await this.#moveTo(observer, change.position, change);
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
    let moved: boolean;
    try {
      moved = await this.#records.log.move(observer.key, {
        from: observer.position,
        now: this.#now(),
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
    if (!moved) {
      // Another deliverer moved it: go on from where it is filed.
      await this.#declare();
      return false;
    }
    observer.position = to;
    observer.failures = 0;
    observer.retryAt = null;
    return true;
  }

  /** File `observer`'s failure on `change`, and when it is tried again. */
  async #failed(
    observer: Observer,
    change: LoggedChange,
    error: unknown
  ): Promise<void> {
    const failures = observer.failures + 1;
    const delay = retryDelay(failures);
    const now = this.#now();
    const message = error instanceof Error ? error.message : String(error);
    observer.failures = failures;
    observer.retryAt = now + delay;
    this.#print(
      `[observe] ${describe(observer.key)} failed on ${change.fact.type} ${String(change.position)} (failure ${String(failures)}; trying again in ${String(Math.round(delay / 1000))}s): ${message}`
    );
    try {
      await this.#records.log.fail(observer.key, {
        error: message,
        now,
        retryAt: observer.retryAt,
      });
    } catch (saving) {
      this.#report(saving);
    }
  }
}

/** An observer as a line names it: `name (source)`. */
function describe(key: ObserverKey): string {
  return `${key.name} (${key.source})`;
}
