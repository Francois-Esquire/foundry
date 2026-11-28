import { withAbort } from "./abort";

export interface KeyedQueueRunOptions {
  readonly signal?: AbortSignal;
}

export class KeyedQueue<Key = string> {
  readonly #tails = new Map<Key, Promise<void>>();

  async run<T>(
    key: Key,
    operation: () => Promise<T>,
    options?: KeyedQueueRunOptions
  ): Promise<T> {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw signal.reason;
    }
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const { promise: done, resolve: release } = Promise.withResolvers<void>();
    const tail = previous.then(() => done);
    this.#tails.set(key, tail);
    try {
      await (signal === undefined ? previous : withAbort(previous, signal));
      if (signal?.aborted) {
        throw signal.reason;
      }
      return await operation();
    } finally {
      release();
      // biome-ignore lint/complexity/noVoid: Detached cleanup of map slot once prior work drains.
      void tail.finally(() => {
        if (this.#tails.get(key) === tail) {
          this.#tails.delete(key);
        }
      });
    }
  }

  async idle(): Promise<void> {
    while (this.#tails.size > 0) {
      await Promise.all(this.#tails.values());
    }
  }
}
