import type { DeliveryClock } from "~/lib/events/delivery";

interface Wait {
  readonly resolve: () => void;
  readonly until: number;
}

/**
 * A delivery clock that moves only when a test moves it: `now` is what it
 * was set to, and a wait ends once `advance` passes its end, never by
 * itself.
 */
export class ManualClock implements DeliveryClock {
  #at: number;
  readonly #waits = new Set<Wait>();

  constructor(at = Date.parse("2026-11-15T12:00:00.000Z")) {
    this.#at = at;
  }

  now(): number {
    return this.#at;
  }

  after(ms: number): { readonly done: Promise<void>; cancel(): void } {
    const { promise, resolve } = Promise.withResolvers<void>();
    const wait: Wait = { resolve, until: this.#at + ms };
    this.#waits.add(wait);
    return {
      cancel: () => {
        this.#waits.delete(wait);
      },
      done: promise,
    };
  }

  /** Move the clock on by `ms`, ending every wait it passes. */
  advance(ms: number): void {
    this.#at += ms;
    for (const wait of [...this.#waits]) {
      if (wait.until <= this.#at) {
        this.#waits.delete(wait);
        wait.resolve();
      }
    }
  }

  /** How many waits are still running: a call's limit, or a stop's grace. */
  get waiting(): number {
    return this.#waits.size;
  }
}
