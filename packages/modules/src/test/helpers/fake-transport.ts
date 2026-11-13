import { vi } from "vitest";
import type { ModuleTransport } from "../../gateway/types";

export class FakeTransport implements ModuleTransport {
  readonly #frames = new FrameQueue();
  readonly #closed = deferred<undefined>();
  readonly incoming = this.#frames;
  readonly closed = this.#closed.promise;
  #ended = false as boolean;
  readonly send = vi.fn(() =>
    this.#ended
      ? Promise.reject(new Error("Transport is closed"))
      : Promise.resolve()
  );
  readonly close = vi.fn((_reason: string) => {
    this.#ended = true;
    this.#frames.end();
    this.#closed.resolve(undefined);
    return Promise.resolve();
  });

  push(frame: unknown): void {
    this.#frames.push(frame);
  }

  disconnect(): void {
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

function deferred<Value>() {
  let resolve: ((value: Value | PromiseLike<Value>) => void) | undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (resolve === undefined) {
    throw new Error("Deferred did not initialize");
  }
  return { promise, resolve };
}
