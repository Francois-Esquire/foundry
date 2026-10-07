/**
 * Runs operations one at a time per key, in call order. A failed operation
 * does not block the ones queued behind it. Keys with nothing queued hold no
 * memory.
 *
 * Share one instance (a module constant) between every object that touches
 * the same resource, so two instances of a store over one file still take
 * turns.
 */
export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const { promise: tail, resolve: release } = Promise.withResolvers<void>();
    this.#tails.set(key, tail);
    try {
      await previous;
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}
