/**
 * What a frame created, by position. A body replays from the top after a
 * suspension, so the n-th call of a kind in a frame must return the same
 * thing it created the first time. Keys are `path|kind|occurrence`; the
 * prefix keeps them ready for `claimEffect` when persistence lands.
 */
export class Ledger {
  readonly #entries = new Map<string, unknown>();

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

  set(key: string, value: unknown): void {
    this.#entries.set(key, value);
  }

  get size(): number {
    return this.#entries.size;
  }
}
