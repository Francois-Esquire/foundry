import { createHash } from "node:crypto";
import type { WorkspaceRecords } from "~/lib/events/records";
import { RecordsHeldError } from "~/lib/events/records";
import type { Handler, Source } from "~/lib/events/source";

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
 */

interface Observer {
  readonly handler: Handler<unknown>;
  readonly hash: string;
  readonly source: symbol;
}

const HASH_LENGTH = 32;

export class Delivery {
  readonly #observers: Observer[] = [];
  readonly #records: WorkspaceRecords;
  readonly #print: (line: string) => void;
  #phase: "new" | "running" | "stopped" = "new";
  #pass: Promise<void> | undefined;
  /** Counts wakes, so a pass knows whether another came in while it ran. */
  #wakes = 0;

  constructor(records: WorkspaceRecords, print: (line: string) => void) {
    this.#records = records;
    this.#print = print;
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
   * Own the records, so a problem with them surfaces here. Without observers
   * nothing is read. Records another process owns are left to it; records
   * that cannot be read fail the start.
   */
  async start(): Promise<void> {
    if (this.#phase !== "new" || this.#observers.length === 0) {
      return;
    }
    try {
      await this.#records.open();
    } catch (error) {
      if (!(error instanceof RecordsHeldError)) {
        throw error;
      }
      this.#print(`[observe] not delivering here: ${error.message}`);
      return;
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
    this.#pass = this.#run().finally(() => {
      this.#pass = undefined;
    });
  }

  /** Start no handler again; wait for the one running. */
  async stop(): Promise<void> {
    this.#phase = "stopped";
    await this.#pass;
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
    for (const item of await this.#records.pending()) {
      for (const observer of this.#observers) {
        if (this.#phase !== "running") {
          return;
        }
        if (
          observer.source !== item.source ||
          item.delivered.includes(observer.hash)
        ) {
          continue;
        }
        try {
          // Each handler gets its own copy: one cannot change what another sees.
          await observer.handler(structuredClone(item.payload));
        } catch (error) {
          this.#print(
            `[observe] handler ${observer.hash.slice(0, 8)} failed on ${item.id}: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }
        try {
          await this.#records.deliver(item.id, observer.hash);
        } catch (error) {
          this.#print(
            `[observe] handler ${observer.hash.slice(0, 8)} completed ${item.id}, but that was not saved and it may run again: ${String(error)}`
          );
        }
      }
    }
  }
}
