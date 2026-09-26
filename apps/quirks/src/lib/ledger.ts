/**
 * What a frame created, by position. A body replays from the top after a
 * suspension, so the n-th call of a kind in a frame must return the same
 * thing it created the first time. Keys are `path|kind|occurrence`. Values
 * are JSON: the ledger is written into the run's file when the run parks,
 * and read back when a later process adopts it.
 */
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
    return `quirks:${path.join(".")}|${kind}|${occurrence}`;
  }

  get<T>(key: string): T | undefined {
    return this.#entries.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** `undefined` forgets the key, so a stale record is replaced on the next set. */
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

  /** For the run file. */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.#entries);
  }
}
