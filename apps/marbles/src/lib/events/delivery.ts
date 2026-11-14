import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { WorkspaceRecords } from "~/lib/events/records";
import type { Handler, Source } from "~/lib/events/source";
import { current } from "~/lib/run-scope";
import type { Lock } from "~/lib/state/locks";
import { acquireLock } from "~/lib/state/locks";

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
 * which the next emitted item or the next start begins. A handler that
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
 * One process delivers a workspace's changes at a time: the one holding
 * `<state>/locks/tasks` from a successful start until `stop` (the lock
 * keeps the name it had when it also guarded the tasks' file). Any number
 * of processes read and write the tasks themselves.
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

/** The lock at a workspace's state dir that makes its holder the one delivering there. */
const DELIVERY_LOCK = "tasks";

export interface DeliveryOptions {
  readonly print: (line: string) => void;
  readonly records: WorkspaceRecords;
  /** The workspace state dir, where delivery is claimed; without one, nothing is claimed. */
  readonly state?: string;
}

export class Delivery {
  readonly #observers: Observer[] = [];
  readonly #records: WorkspaceRecords;
  readonly #print: (line: string) => void;
  readonly #state: string | undefined;
  #lock: Lock | undefined;
  #phase: "new" | "running" | "stopped" = "new";
  #pass: Promise<void> | undefined;
  #wakes = 0;
  /** Runs a pass in the context this delivery was built in; see above. */
  readonly #built = AsyncLocalStorage.snapshot();

  constructor(options: DeliveryOptions) {
    this.#records = options.records;
    this.#print = options.print;
    this.#state = options.state;
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
   * process has claimed is left to it; records that cannot be read fail the
   * start.
   */
  async start(): Promise<void> {
    if (this.#phase !== "new" || this.#observers.length === 0) {
      return;
    }
    if (this.#state !== undefined) {
      const claim = acquireLock(this.#state, DELIVERY_LOCK);
      if (!("release" in claim)) {
        this.#print(
          `[observe] not delivering here: the changes of this workspace (${this.#state}) are delivered by ${claim.holder}`
        );
        return;
      }
      this.#lock = claim;
    }
    try {
      await this.#records.pending();
    } catch (error) {
      this.#release();
      throw error;
    }
    this.#phase = "running";
  }

  /** Begin a pass, or another after the one in progress. */
  wake(): void {
    if (this.#phase !== "running") {
      return;
    }
    this.#wakes += 1;
    if (this.#pass !== undefined) {
      return;
    }
    this.#pass = this.#built(() => current.exit(() => this.#run())).finally(
      () => {
        this.#pass = undefined;
      }
    );
  }

  /** Start no handler again; wait for the one running, then give up the claim. */
  async stop(): Promise<void> {
    this.#phase = "stopped";
    try {
      await this.#pass;
    } finally {
      this.#release();
    }
  }

  #release(): void {
    this.#lock?.release();
    this.#lock = undefined;
  }

  async #run(): Promise<void> {
    let seen: number;
    do {
      seen = this.#wakes;
      try {
        await this.#deliverPending();
      } catch (error) {
        this.#print(`[observe] ${String(error)}`);
      }
    } while (seen !== this.#wakes && this.#phase === "running");
  }

  async #deliverPending(): Promise<void> {
    const held = new Set<Observer>();
    for (const item of await this.#records.pending()) {
      for (const observer of this.#observers) {
        if (this.#phase !== "running") {
          return;
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
    }
  }
}
