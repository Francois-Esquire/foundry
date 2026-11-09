import { vi } from "vitest";
import type { ModuleTransport } from "../../gateway/types";

/** A transport that, like a socket, refuses to send once it has closed. */
export class FakeTransport implements ModuleTransport {
  readonly #frames = new FrameQueue();
  readonly #closed = Promise.withResolvers<undefined>();
  // Widened so lint sees the flag as mutable; closing sets it later.
  #ended = false as boolean;
  readonly incoming = this.#frames;
  readonly closed = this.#closed.promise;
  readonly send = vi.fn((_frame: unknown) =>
    this.#ended
      ? Promise.reject(new Error("Transport is closed"))
      : Promise.resolve()
  );
  readonly close = vi.fn((_reason: string) => {
    this.disconnect();
    return Promise.resolve();
  });

  push(frame: unknown): void {
    this.#frames.push(frame);
  }

  disconnect(): void {
    this.#ended = true;
    this.#frames.end();
    this.#closed.resolve(undefined);
  }
}

class FrameQueue implements AsyncIterableIterator<unknown> {
  readonly #queued: unknown[] = [];
  #waiting: ((result: IteratorResult<unknown>) => void) | undefined;
  // Widened so lint sees the flag as mutable; `end()` sets it later.
  #ended = false as boolean;

  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    return this;
  }

  next(): Promise<IteratorResult<unknown>> {
    const value = this.#queued.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.#ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }

  return(): Promise<IteratorResult<unknown>> {
    this.end();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(value: unknown): void {
    if (this.#ended) {
      throw new Error("Frame queue has ended");
    }
    const waiting = this.#waiting;
    if (waiting === undefined) {
      this.#queued.push(value);
      return;
    }
    this.#waiting = undefined;
    waiting({ done: false, value });
  }

  end(): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ done: true, value: undefined });
  }
}
