import type { DeliveryClock } from "~/lib/events/delivery";

interface Wait {
  readonly resolve: () => void;
  readonly until: number;
}

/**
 * A delivery clock that moves only when a test moves it: `now` is what it
 * was set to, a wait ends once `advance` passes its end, and a tick is
 * called as `advance` passes each of its periods, never by itself.
 */
export class ManualClock implements DeliveryClock {
  #at: number;
  readonly #waits = new Set<Wait>();
  readonly #ticks = new Set<{
    next: number;
    readonly ms: number;
    readonly tick: () => void;
  }>();

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

  every(ms: number, tick: () => void): { cancel(): void } {
    const ticking = { ms, next: this.#at + ms, tick };
    this.#ticks.add(ticking);
    return {
      cancel: () => {
        this.#ticks.delete(ticking);
      },
    };
  }

  /**
   * Move the clock on by `ms`, ending every wait it passes, and calling
   * each tick that fell due once, however many of its periods passed, as
   * an interval held up by a busy loop fires once.
   */
  advance(ms: number): void {
    this.#at += ms;
    for (const wait of [...this.#waits]) {
      if (wait.until <= this.#at) {
        this.#waits.delete(wait);
        wait.resolve();
      }
    }
    for (const ticking of [...this.#ticks]) {
      if (ticking.next <= this.#at) {
        ticking.next = this.#at + ticking.ms;
        ticking.tick();
      }
    }
  }

  /** How many ticks are still set: a delivery's poll, until it stops. */
  get ticking(): number {
    return this.#ticks.size;
  }

  /** How many waits are still running: a call's limit, or a stop's grace. */
  get waiting(): number {
    return this.#waits.size;
  }
}
