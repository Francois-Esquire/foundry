import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { StreamItem, WorkspaceRecords } from "~/lib/events/records";
import { PENDING_BATCH } from "~/lib/events/records";
import type { Handler, Source } from "~/lib/events/source";
import { current } from "~/lib/run-scope";
import type { Lock } from "~/lib/state/locks";
import { acquireLock } from "~/lib/state/locks";

interface Observer {
  readonly handler: Handler<unknown>;
  readonly hash: string;
  readonly source: symbol;
}

const HASH_LENGTH = 32;

const DELIVERY_LOCK = "tasks";

export const DELIVERY_POLL_MS = 1000;

export interface DeliveryOptions {
  readonly print: (line: string) => void;
  readonly records: WorkspaceRecords;
  readonly state?: string;
}

export class Delivery {
  readonly #observers: Observer[] = [];
  readonly #records: WorkspaceRecords;
  readonly #print: (line: string) => void;
  readonly #state: string | undefined;
  #lock: Lock | undefined;
  #phase: "new" | "waiting" | "running" | "stopped" = "new";
  #pass: Promise<void> | undefined;
  #again = false;
  #seen = -1;
  #floor = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #problem: string | undefined;
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

  async start(): Promise<void> {
    if (this.#phase !== "new" || this.#observers.length === 0) {
      return;
    }
    const holder = this.#claim();
    if (holder !== undefined) {
      this.#print(
        `[observe] not delivering here: the changes of this workspace (${this.#state}) are delivered by ${holder}; delivering here once it stops`
      );
      this.#phase = "waiting";
      this.#tickEvery();
      return;
    }
    try {
      await this.#records.latest();
    } catch (error) {
      this.#release();
      throw error;
    }
    this.#phase = "running";
    this.#tickEvery();
  }

  wake(): void {
    if (this.#phase !== "running") {
      return;
    }
    if (this.#pass !== undefined) {
      this.#again = true;
      return;
    }
    this.#again = false;
    this.#pass = this.#built(() => current.exit(() => this.#run()));
  }

  async stop(): Promise<void> {
    this.#phase = "stopped";
    clearInterval(this.#timer);
    this.#timer = undefined;
    try {
      await this.#pass;
    } finally {
      this.#release();
    }
  }

  #claim(): string | undefined {
    if (this.#state === undefined) {
      return;
    }
    const claim = acquireLock(this.#state, DELIVERY_LOCK);
    if (!("release" in claim)) {
      return claim.holder;
    }
    this.#lock = claim;
  }

  #release(): void {
    this.#lock?.release();
    this.#lock = undefined;
  }

  #tickEvery(): void {
    this.#timer = setInterval(() => {
      this.#tick();
    }, DELIVERY_POLL_MS);
    this.#timer.unref?.();
  }

  #tick(): void {
    if (this.#phase === "running") {
      this.wake();
      return;
    }
    if (this.#phase !== "waiting") {
      return;
    }
    let holder: string | undefined;
    try {
      holder = this.#claim();
    } catch (error) {
      this.#report(error);
      return;
    }
    if (holder === undefined) {
      this.#print(
        "[observe] delivering here: the process that delivered let go"
      );
      this.#phase = "running";
      this.wake();
    }
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
          await this.#deliverNew();
          this.#problem = undefined;
        } catch (error) {
          this.#report(error);
        }
      } while (this.#takeAgain() && this.#phase === "running");
    } finally {
      this.#pass = undefined;
    }
  }

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
    if (held.size === 0) {
      this.#floor = this.#seen;
    }
  }

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
