import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as AiModule from "ai";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockEmbedMany = vi.fn();

vi.mock("ai", async (orig) => {
  const actual = await orig<typeof AiModule>();
  return { ...actual, embedMany: mockEmbedMany };
});

vi.mock("@huggingface/transformers", () => ({ env: {}, pipeline: vi.fn() }));

vi.mock("@browser-ai/transformers-js", () => ({
  transformersJS: {
    embeddingModel: vi.fn(),
    languageModel: vi.fn(),
    transcriptionModel: vi.fn(),
  },
}));

const { embedChunks } = await import("../../embeddings/pipeline");

// Deterministic fake embedding so the whole pipeline runs offline.
function fakeEmbed(text: string): number[] {
  const v: number[] = new Array<number>(8).fill(0);
  for (const w of text.toLowerCase().split(/\W+/)) {
    if (!w) {
      continue;
    }
    const i = w.length % 8;
    v[i] = (v[i] ?? 0) + 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

beforeEach(() => {
  mockEmbedMany.mockReset();
  mockEmbedMany.mockImplementation(({ values }: { values: string[] }) =>
    Promise.resolve({
      embeddings: values.map(fakeEmbed),
      usage: { tokens: values.length * 3 },
    })
  );
});

const FAKE_MODEL = { modelId: "fake-embed", provider: "fake" };
const fakeSource = { embedding: () => FAKE_MODEL } as never;

// ── corpus assembly (real models/src, as the old pipeline integration did) ───

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

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

// ── recursive at scale — the full corpus, end to end ─────────────────────────

describe("embedChunks integration — recursive over the real corpus", () => {
  const SIZE = 512;

  it("embeds every chunk, in order, with valid offsets and vectors", async () => {
    const out = await collect(
      embedChunks(corpus, fakeSource, { chunkSize: SIZE, method: "recursive" })
    );

    expect(out.length).toBeGreaterThan(100);
    // Sequential indices.
    expect(out.map((c) => c.index)).toEqual(
      Array.from({ length: out.length }, (_, i) => i)
    );
    // Every chunk: bounded, embedded, offset-accurate.
    for (const c of out) {
      expect(c.tokenCount).toBeLessThanOrEqual(SIZE);
      expect(c.vector).toHaveLength(c.dimensions);
      expect(corpus.slice(c.startIndex, c.endIndex)).toBe(c.text);
    }
    // Chunk texts reconstruct the corpus (recursive @512 preserves coverage).
    expect(out.map((c) => c.text).join("")).toBe(corpus);

    const summary = {
      dimensions: out[0]?.dimensions,
      embeddedChunks: out.length,
      embedManyCalls: mockEmbedMany.mock.calls.length,
    };
    console.log("[embedChunks corpus recursive @512]", JSON.stringify(summary));
  });
});

// ── semantic is the default — exercised on a real code excerpt ───────────────

describe("embedChunks integration — semantic default", () => {
  it("uses semantic chunking when no method is given and embeds each chunk", async () => {
    const excerpt = corpus.slice(0, 8000);
    const out = await collect(
      embedChunks(excerpt, fakeSource, { chunkSize: 256 })
    );

    expect(out.length).toBeGreaterThan(0);
    expect(out.map((c) => c.text).join("")).toBe(excerpt);
    for (const c of out) {
      expect(c.vector).toHaveLength(c.dimensions);
      expect(c.tokenCount).toBeGreaterThan(0);
    }
    // Semantic embeds twice (boundary detection + chunk vectors), so it issues
    // strictly more embedMany calls than the chunk batches alone would.
    expect(mockEmbedMany.mock.calls.length).toBeGreaterThan(
      Math.ceil(out.length / 32)
    );
  });
});
