export class BoundedBytes {
  readonly #chunks: Uint8Array[] = [];
  #head = 0;
  #size = 0;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) {
      return;
    }
    if (chunk.byteLength >= this.#limit) {
      this.#chunks.length = 0;
      this.#chunks.push(new Uint8Array(chunk.subarray(-this.#limit)));
      this.#head = 0;
      this.#size = this.#limit;
      return;
    }
    this.#chunks.push(new Uint8Array(chunk));
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
