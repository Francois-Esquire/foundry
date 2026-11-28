import type { DeliveryClock } from "~/lib/events";

interface Wait {
  readonly resolve: () => void;
  readonly until: number;
}

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

  get periods(): readonly number[] {
    return [...this.#ticks].map((ticking) => ticking.ms);
  }

  get ticking(): number {
    return this.#ticks.size;
  }

  get waiting(): number {
    return this.#waits.size;
  }
}
