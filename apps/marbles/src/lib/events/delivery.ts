import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { StreamItem, WorkspaceRecords } from "~/lib/events/records";
import { PENDING_BATCH } from "~/lib/events/records";
import type { Handler, Source } from "~/lib/events/source";
import type { ExecutionContext } from "~/lib/execution-context";
import { inContext } from "~/lib/execution-context";
import { current } from "~/lib/run-scope";

/**
 * Hands each stored item to every observer of its source that has not
 * completed it, and records each completion by the observer's hash.
 *
 * An observer is known by a hash of its handler's text, as
 * `Function.prototype.toString` gives it, and its place among observers of
 * that source with the same text, in registration order. The hash survives a
 * restart of unchanged source; it is not identity:
 *
 * - Captured values are not part of it: `observe(tasks, notify("a"))` and
 *   `observe(tasks, notify("b"))` differ only by that place, so swapping the
 *   two registrations swaps which has delivered what.
 * - An edit to a handler's code makes it a new observer, and every observer
 *   receives every item it has not completed. Items are never removed, so a
 *   new or edited observer receives the workspace's whole history. Under Bun
 *   the text is the transpiled code, without types or comments, so editing
 *   only those may keep the hash, and a Bun that transpiles differently
 *   changes them all.
 *
 * One pass at a time; within it, items oldest first and each observer in
 * registration order, one handler at a time, outside any write. A handler
 * that throws leaves its hash absent and is tried again on the next pass,
 * which the next recorded change (made here, or elsewhere and noticed by
 * the next tick) or the next start begins. A handler that
 * completed but whose hash could not be saved runs again: delivery is at
 * least once, never exactly once.
 *
 * Each observer sees items in the order they were stored: it is handed an
 * item only once every earlier item of its source is recorded as completed
 * by it. A handler that throws, or whose completion could not be saved, is
 * handed nothing more in that pass, so the item it did not complete is the
 * first it gets next time, before any later one. Other observers go on. The
 * cost is the usual one of ordered delivery: an item a handler keeps failing
 * on holds back that handler's later items until it completes it.
 *
 * One engine delivers a workspace's changes at a time: the one whose
 * records granted it the claim (`claimDelivery`), from a successful start
 * until `stop`. Any number of processes read and write the tasks
 * themselves. The deliverer is woken
 * at once by a change made through its own records, and notices one made
 * elsewhere within `DELIVERY_POLL_MS`. A process refused the claim tries
 * again on the same interval, and delivers the backlog once it has it.
 *
 * A pass never runs inside a run. A write inside a step body wakes delivery
 * as its turn ends, and a pass started there would otherwise inherit that
 * step's frame: a definition a handler calls would join the writer's run
 * as a dynamic child instead of starting a run of its own. So a pass runs
 * in the async context this delivery was built in, not the waker's (which
 * also keeps a host's per-call output capture out of it), and with no run
 * frame even when it was built inside a step body, as an `Engine` can be.
 * A handler's calls therefore run like any call outside a step; calls made
 * inside a step body still join that step's run.
 */

interface Observer {
  readonly handler: Handler<unknown>;
  readonly hash: string;
  readonly source: symbol;
}

const HASH_LENGTH = 32;

/**
 * How often, in ms, a running delivery looks for changes another process
 * recorded (one cheap read: the newest change's position against the one
 * its last pass began at), and a delivery another process holds tries to
 * claim it again. A change made in this process wakes delivery at once.
 */
export const DELIVERY_POLL_MS = 1000;

export interface DeliveryOptions {
  /** What every handler runs as: the engine's workspace, outside any run. */
  readonly context?: ExecutionContext;
  readonly print: (line: string) => void;
  /** The workspace's records, which also decide who delivers its changes. */
  readonly records: WorkspaceRecords;
}

export class Delivery {
  readonly #observers: Observer[] = [];
  readonly #context: ExecutionContext | undefined;
  readonly #records: WorkspaceRecords;
  readonly #print: (line: string) => void;
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
   * The newest change a pass has covered: the last before it read, or one
   * it handed out; -1 until the first pass, which covers the backlog.
   */
  #seen = -1;
  /**
   * The position up to which every observer here has completed every
   * change, as the last pass found it: the next pass reads from there, so
   * its work follows what is left to deliver, not the whole history. 0 at
   * the start, so an observer declared since the last process receives
   * the history once.
   */
  #floor = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** The last problem a tick printed, so a lasting one is printed once. */
  #problem: string | undefined;
  /** Runs a pass in the context this delivery was built in; see above. */
  readonly #built = AsyncLocalStorage.snapshot();

  constructor(options: DeliveryOptions) {
    this.#records = options.records;
    this.#print = options.print;
    this.#context = options.context;
  }

  /** Follow `source` with `handler`, from the next start or the next pass. */
  observe<T>(source: Source<T>, handler: Handler<T>): void {
    const text = handler.toString();
    const place = this.#observers.filter(
      (observer) =>
        observer.source === source && observer.handler.toString() === text
    ).length;
    this.#observers.push({
      // A source emits only its own payload type.
      handler: handler as Handler<unknown>,
      hash: createHash("sha256")
        .update(`${text}\0${String(place)}`)
        .digest("hex")
        .slice(0, HASH_LENGTH),
      source,
    });
  }

  /**
   * Claim delivery, and read the records, so a problem with them surfaces
   * here. Without observers nothing is claimed or read. Delivery another
   * process has claimed is left to it, and claimed here once it lets go
   * (or exits, leaving its lock to be taken over), on a later tick; records
   * that cannot be read fail the start.
   */
  async start(): Promise<void> {
    if (this.#phase !== "new" || this.#observers.length === 0) {
      return;
    }
    this.#phase = "starting";
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
      await this.#records.latest();
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
  }

  /**
   * Begin a pass, or another after the one in progress. A pass hands out
   * anything only when a change newer than the last it covered was
   * recorded (or it is the first since the start), so a handler that
   * failed is tried again on the next change or the next start, not on
   * every wake.
   */
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

  /** Claim delivery when waiting; when running, wake to look for a change recorded elsewhere. */
  #tick(): void {
    if (this.#phase === "running") {
      // The pass's first read is the cheap check for a change made elsewhere.
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
    } catch (error) {
      this.#report(error);
      return;
    }
    if (holder !== undefined) {
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
          await this.#deliverNew();
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
   * Hand out what is left to deliver, in batches: the changes some observer
   * has not completed (`pending`), oldest first.
   */
  async #deliverNew(): Promise<void> {
    const head = await this.#records.latest();
    if (head <= this.#seen) {
      return;
    }
    const held = new Set<Observer>();
    const handlers = this.#observers.map((observer) => observer.hash);
    const read = (after: number) =>
      this.#records.pending({ after, handlers, limit: PENDING_BATCH });
    let batch = await read(this.#floor);
    // Everything before the first change some observer has not completed
    // is done for all of them; with none, everything up to `head` is.
    const [oldest] = batch;
    this.#floor = oldest === undefined ? head : oldest.position - 1;
    for (;;) {
      for (const item of batch) {
        this.#seen = Math.max(this.#seen, item.position);
        if (!(await this.#deliverItem(item, held))) {
          return;
        }
      }
      const last = batch.at(-1);
      if (last === undefined || batch.length < PENDING_BATCH) {
        break;
      }
      batch = await read(last.position);
    }
    this.#seen = Math.max(this.#seen, head);
    // Every observer completed everything this pass handed out, and the
    // rest it covered was complete already.
    if (held.size === 0) {
      this.#floor = this.#seen;
    }
  }

  /** Hand `item` to every observer that has not completed it; false once stopped. */
  async #deliverItem(item: StreamItem, held: Set<Observer>): Promise<boolean> {
    for (const observer of this.#observers) {
      if (this.#phase !== "running") {
        return false;
      }
      if (
        held.has(observer) ||
        observer.source !== item.source ||
        item.delivered.includes(observer.hash)
      ) {
        continue;
      }
      try {
        // Each handler gets its own copy: one cannot change what another sees.
        await observer.handler(structuredClone(item.payload));
      } catch (error) {
        held.add(observer);
        this.#print(
          `[observe] handler ${observer.hash.slice(0, 8)} failed on ${item.id}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      try {
        await this.#records.deliver(item.id, observer.hash);
      } catch (error) {
        held.add(observer);
        this.#print(
          `[observe] handler ${observer.hash.slice(0, 8)} completed ${item.id}, but that was not saved and it may run again: ${String(error)}`
        );
      }
    }
    return true;
  }
}
