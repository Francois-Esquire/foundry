import { describe, expect, it } from "vitest";

import {
  codeChunk,
  codeChunkStream,
  downloadCodeLanguages,
} from "../../embeddings/code";

/**
 * Runs against the real tree-sitter TypeScript grammar, which is downloaded
 * unless already cached. It is part of the
 * integration project, not the default unit suite:
 *
 *   bun run --cwd=packages/models test:integration -- code.integration
 *
 * If the grammar is not cached and cannot be downloaded, the file fails with
 * CODE_GRAMMAR_DOWNLOAD_FAILED; it does not skip.
 */
await downloadCodeLanguages(["typescript"]);

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

describe("codeChunk integration — real TypeScript grammar", () => {
  const SIZE = 80;

  it("splits real source on structure with contiguous, source-accurate offsets", async () => {
    const chunks = await codeChunk(SOURCE, "typescript", { chunkSize: SIZE });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.text).join("")).toBe(SOURCE);
    expect(chunks[0]?.startIndex).toBe(0);
    expect(chunks.at(-1)?.endIndex).toBe(SOURCE.length);
    for (const [i, c] of chunks.entries()) {
      expect(SOURCE.slice(c.startIndex, c.endIndex)).toBe(c.text);
      expect(c.tokenCount).toBeGreaterThan(0);
      if (i > 0) {
        expect(c.startIndex).toBe(chunks[i - 1]?.endIndex);
      }
    }
  });

  it("streams from a source identically to the one-shot result", async () => {
    const oneShot = await codeChunk(SOURCE, "typescript", { chunkSize: SIZE });
    const streamed = await collect(
      codeChunkStream(asAsyncStream(SOURCE), "typescript", { chunkSize: SIZE })
    );
    expect(streamed).toEqual(oneShot);
  });
});
