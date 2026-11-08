import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { Chunk } from "../../embeddings/recursive";

import { recursiveChunk } from "../../embeddings/recursive";

const SENTENCE_TERMINATOR_PATTERN = /[.!?}\])"']$/;

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let corpus = "";

beforeAll(async () => {
  const entries = await readdir(SRC_DIR, { recursive: true });
  const tsFiles = entries
    .filter((e) => e.endsWith(".ts"))
    .sort()
    .map((e) => resolve(SRC_DIR, e));
  const contents = await Promise.all(
    tsFiles.map(async (p) => {
      const text = await readFile(p, "utf8");
      return `// === ${p.slice(SRC_DIR.length + 1)} ===\n${text}`;
    })
  );
  corpus = contents.join("\n");
});

// A prose fixture — closer to the entity/memory fields production actually
// embeds than the code corpus. RecursiveChunker's default rules are prose-tuned.
const PROSE = [
  "The user prefers concise answers and dislikes filler. They work primarily in TypeScript on a Bun monorepo.",
  "Mike is a senior engineer focused on agent infrastructure. He values clean, layered seams and is wary of premature abstraction.",
  "The project is a Turborepo with packages for models, agents, database, and a desktop Electron app. Embeddings back entity and memory search.",
].join("\n\n");

function reconstructs(chunks: Chunk[], source: string): boolean {
  return chunks.map((c) => c.text).join("") === source;
}

function offsetsRoundTrip(chunks: Chunk[], source: string): boolean {
  return chunks.every((c) => source.slice(c.startIndex, c.endIndex) === c.text);
}

describe("recursiveChunk — chonkie on the real corpus", () => {
  const SIZE = 512;

  it("initializes WASM and cuts bounded, boundary-respecting chunks with full coverage", async () => {
    const chunks = await recursiveChunk(corpus, { chunkSize: SIZE });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.tokenCount > 0 && c.tokenCount <= SIZE)).toBe(
      true
    );
    expect(reconstructs(chunks, corpus)).toBe(true);
    expect(offsetsRoundTrip(chunks, corpus)).toBe(true);
    // Respecting boundaries leaves some chunks short of the cap, so the count
    // is at least a blind ceil(len / size) slice.
    expect(chunks.length).toBeGreaterThanOrEqual(
      Math.ceil(corpus.length / SIZE)
    );
  });
});

describe("recursiveChunk — prose splits on paragraph/sentence boundaries", () => {
  it("groups the prose fixture into clean, boundary-aligned chunks", async () => {
    const chunks = await recursiveChunk(PROSE, { chunkSize: 256 });
    expect(reconstructs(chunks, PROSE)).toBe(true);
    for (const c of chunks) {
      const trimmed = c.text.trimEnd();
      expect(SENTENCE_TERMINATOR_PATTERN.test(trimmed)).toBe(true);
    }
  });
});

describe("recursiveChunk — coverage degrades below the realistic floor", () => {
  // Documents the threshold: at sub-sentence sizes chonkie trims boundary
  // whitespace during word-level splits, so coverage drops below 100%. This is
  // the reason DEFAULT_RECURSIVE_CHUNK_SIZE sits well above it.
  it("a tiny chunkSize no longer reconstructs the source byte-for-byte", async () => {
    const chunks = await recursiveChunk(corpus, { chunkSize: 40 });
    const kept = chunks.map((c) => c.text).join("").length;
    expect(kept).toBeLessThan(corpus.length);
    expect(chunks.every((c) => c.tokenCount <= 40)).toBe(true);
  });
});
