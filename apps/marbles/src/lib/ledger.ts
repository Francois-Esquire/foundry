export class Ledger {
  readonly #entries: Map<string, unknown>;

  constructor(entries: Readonly<Record<string, unknown>> = {}) {
    this.#entries = new Map(Object.entries(entries));
  }

  static key(
    path: readonly string[],
    kind: string,
    occurrence: number
  ): string {
    return `marbles:${path.join(".")}|${kind}|${occurrence}`;
  }

  get<T>(key: string): T | undefined {
    return this.#entries.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  set(key: string, value: unknown): void {
    if (value === undefined) {
      this.#entries.delete(key);
      return;
    }
    this.#entries.set(key, value);
  }

  get size(): number {
    return this.#entries.size;
  }

  forget(path: readonly string[]): void {
    const prefix = `marbles:${path.join(".")}|`;
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.#entries.delete(key);
      }
    }
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.#entries);
  }
}
