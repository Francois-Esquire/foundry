/**
 * The last `limit` bytes appended. Chunks are kept as they came and joined
 * once in {@link BoundedBytes.text}, so an append costs its own length rather
 * than a copy of everything retained so far.
 */
export class BoundedBytes {
  readonly #chunks: Uint8Array[] = [];
  /** Index of the oldest retained chunk; earlier slots are already dropped. */
  #head = 0;
  #size = 0;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Uint8Array): void {
    // An empty chunk would only take a slot in `#chunks`.
    if (chunk.byteLength === 0) {
      return;
    }
    if (chunk.byteLength >= this.#limit) {
      this.#chunks.length = 0;
      this.#chunks.push(chunk.slice(-this.#limit));
      this.#head = 0;
      this.#size = this.#limit;
      return;
    }
    // Copied: the caller may reuse its buffer for the next chunk.
    this.#chunks.push(chunk.slice());
    this.#size += chunk.byteLength;
    while (this.#size > this.#limit) {
      const oldest = this.#chunks[this.#head];
      if (oldest === undefined) {
        break;
      }
      const excess = this.#size - this.#limit;
      if (oldest.byteLength <= excess) {
        this.#head += 1;
        this.#size -= oldest.byteLength;
      } else {
        this.#chunks[this.#head] = oldest.subarray(excess);
        this.#size -= excess;
      }
    }
    // Compact once the dropped prefix is the larger part, so the array stays
    // proportional to what is retained.
    if (this.#head > this.#chunks.length / 2) {
      this.#chunks.splice(0, this.#head);
      this.#head = 0;
    }
  }

  text(): string {
    const joined = new Uint8Array(this.#size);
    let offset = 0;
    for (const chunk of this.#chunks.slice(this.#head)) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  }
}
