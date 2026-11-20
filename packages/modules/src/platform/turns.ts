export class KeyedTurns<Key> {
  readonly #tails = new Map<Key, Promise<void>>();

  run<Result>(key: Key, operation: () => Promise<Result>): Promise<Result> {
    const prior = this.#tails.get(key) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.#tails.set(key, tail);
    tail.then(() => {
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    });
    return result;
  }

  async idle(): Promise<void> {
    while (this.#tails.size > 0) {
      await Promise.all(this.#tails.values());
    }
  }
}
