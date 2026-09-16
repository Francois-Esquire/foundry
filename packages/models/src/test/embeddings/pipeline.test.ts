import type * as AiModule from "ai";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEmbedMany = vi.fn();

vi.mock("ai", async (orig) => {
  const actual = await orig<typeof AiModule>();
  return { ...actual, embedMany: mockEmbedMany };
});

vi.mock("@huggingface/transformers", () => ({
  env: {},
  pipeline: vi.fn(),
}));

vi.mock("@browser-ai/transformers-js", () => ({
  transformersJS: {
    embeddingModel: vi.fn(),
    languageModel: vi.fn(),
    transcriptionModel: vi.fn(),
  },
}));

const { embedChunks } = await import("../../embeddings/pipeline");

// Deterministic, topic-separable fake embedding (same scheme as semantic.test).
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

afterEach(() => {
  mockEmbedMany.mockReset();
});

const FAKE_MODEL = { modelId: "fake-embed", provider: "fake" };
const fakeSource = { embedding: () => FAKE_MODEL } as never;

const TWO_TOPIC = [
  "Cats are small carnivorous mammals.",
  "They are kept as pets across the world.",
  "Felines groom themselves frequently.",
  "Kittens learn to hunt through play.",
  "The stock market fell sharply today.",
  "Investors worried about rising inflation.",
  "Bond yields climbed in response.",
  "Analysts expect more volatility ahead.",
].join(" ");

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

async function* asAsyncStream(text: string, size = 16): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) {
    await Promise.resolve();
    yield text.slice(i, i + size);
  }
}

// ── embedChunks — shape, ordering, defaults ──────────────────────────────────

describe("embedChunks", () => {
  it("defaults to semantic chunking and yields embedded chunks", async () => {
    const out = await collect(embedChunks(TWO_TOPIC, fakeSource));
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.vector).toHaveLength(8);
      expect(c.dimensions).toBe(8);
      expect(c.model).toBe("fake-embed");
      expect(c.tokenCount).toBeGreaterThan(0);
      expect(c.vector).toEqual(fakeEmbed(c.text));
    }
  });

  it("emits sequential indices and source-accurate offsets", async () => {
    const out = await collect(
      embedChunks(TWO_TOPIC, fakeSource, {
        chunkSize: 64,
        method: "recursive",
      })
    );
    expect(out.map((c) => c.index)).toEqual(
      Array.from({ length: out.length }, (_, i) => i)
    );
    for (const c of out) {
      expect(TWO_TOPIC.slice(c.startIndex, c.endIndex)).toBe(c.text);
    }
  });

  it("batches the embed pass: ceil(chunks / batchSize) embedMany calls", async () => {
    // Recursive isolates the chunk-embed pass (no boundary-detection embed).
    const chunks = await collect(
      embedChunks(TWO_TOPIC, fakeSource, {
        chunkSize: 32,
        method: "recursive",
      })
    );
    mockEmbedMany.mockClear();

    await collect(
      embedChunks(TWO_TOPIC, fakeSource, {
        batchSize: 2,
        chunkSize: 32,
        method: "recursive",
      })
    );
    expect(mockEmbedMany).toHaveBeenCalledTimes(Math.ceil(chunks.length / 2));
  });

  it("accepts a streamed source, identical to the string result", async () => {
    const opts = { chunkSize: 64, method: "recursive" as const };
    const fromString = await collect(embedChunks(TWO_TOPIC, fakeSource, opts));
    const fromStream = await collect(
      embedChunks(asAsyncStream(TWO_TOPIC), fakeSource, opts)
    );
    expect(fromStream).toEqual(fromString);
  });

  it("yields nothing and never embeds for empty input", async () => {
    const out = await collect(embedChunks("", fakeSource));
    expect(out).toEqual([]);
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });

  it("throws on an embedding count mismatch", async () => {
    mockEmbedMany.mockResolvedValueOnce({
      embeddings: [],
      usage: { tokens: 0 },
    });
    await expect(
      collect(
        embedChunks(TWO_TOPIC, fakeSource, {
          chunkSize: 64,
          method: "recursive",
        })
      )
    ).rejects.toThrow();
  });

  it("reports embed telemetry on a caller-provided session", async () => {
    const captureEmbed = vi.fn();
    const session = { captureEmbed } as never;
    await collect(
      embedChunks(TWO_TOPIC, fakeSource, {
        chunkSize: 64,
        method: "recursive",
        session,
      })
    );
    expect(captureEmbed).toHaveBeenCalled();
    expect(captureEmbed.mock.calls[0]?.[0]).toMatchObject({
      model: "fake-embed",
    });
  });
});
