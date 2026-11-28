export class KeyedQueue<Key = string> {
  readonly #tails = new Map<Key, Promise<void>>();

  async run<T>(key: Key, operation: () => Promise<T>): Promise<T> {
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

  async idle(): Promise<void> {
    while (this.#tails.size > 0) {
      await Promise.all(this.#tails.values());
    }
  }
}
