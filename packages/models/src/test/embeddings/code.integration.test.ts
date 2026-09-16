import { describe, expect, it } from "vitest";

import {
  codeChunk,
  codeChunkStream,
  downloadCodeLanguages,
} from "../../embeddings/code";

// Real tree-sitter grammar, fetched on demand. If the network is unavailable
// (offline/sandboxed CI), warm fails and the whole suite skips rather than
// erroring — the grammar genuinely isn't obtainable here.
let ready = true;
try {
  await downloadCodeLanguages(["typescript"]);
} catch {
  ready = false;
}

const SOURCE = `import { readFile } from "node:fs/promises";

export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  private total = 0;
  add(n: number): this {
    this.total += n;
    return this;
  }
  result(): number {
    return this.total;
  }
}

export async function load(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export const PI = 3.14159;
`;

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

async function* asAsyncStream(text: string, size = 24): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) {
    await Promise.resolve();
    yield text.slice(i, i + size);
  }
}

describe.skipIf(!ready)(
  "codeChunk integration — real TypeScript grammar",
  () => {
    const SIZE = 80;

    it("splits real source on structure, preserving coverage and offsets", async () => {
      const chunks = await codeChunk(SOURCE, "typescript", { chunkSize: SIZE });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((c) => c.text).join("")).toBe(SOURCE);
      for (const c of chunks) {
        expect(SOURCE.slice(c.startIndex, c.endIndex)).toBe(c.text);
        expect(c.tokenCount).toBeGreaterThan(0);
      }

      const summary = {
        chunks: chunks.length,
        tokenCounts: chunks.map((c) => c.tokenCount),
      };
      console.log("[codeChunk typescript @80]", JSON.stringify(summary));
    });

    it("offsets are contiguous and cover the whole source", async () => {
      const chunks = await codeChunk(SOURCE, "typescript", { chunkSize: SIZE });
      expect(chunks[0]?.startIndex).toBe(0);
      expect(chunks.at(-1)?.endIndex).toBe(SOURCE.length);
      for (let i = 1; i < chunks.length; i += 1) {
        expect(chunks[i]?.startIndex).toBe(chunks[i - 1]?.endIndex);
      }
    });

    it("streams from a source identically to the one-shot result", async () => {
      const oneShot = await codeChunk(SOURCE, "typescript", {
        chunkSize: SIZE,
      });
      const streamed = await collect(
        codeChunkStream(asAsyncStream(SOURCE), "typescript", {
          chunkSize: SIZE,
        })
      );
      expect(streamed).toEqual(oneShot);
    });
  }
);
