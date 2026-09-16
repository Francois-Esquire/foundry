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

const { semanticChunk, semanticChunkStream, toEmbedFunction } = await import(
  "../../embeddings/semantic"
);
const { recursiveChunk, recursiveChunkStream } = await import(
  "../../embeddings/recursive"
);
const { collectSource } = await import("../../embeddings/source");

// ── deterministic, topic-separable fake embedding ────────────────────────────
// A bag-of-words hash into a small fixed-dim vector, normalized. Texts that
// share words land near each other, so the real SemanticChunker sees genuine
// similarity valleys at topic boundaries — no network, fully deterministic.
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
      usage: { tokens: 0 },
    })
  );
});

afterEach(() => {
  mockEmbedMany.mockReset();
});

const FAKE_MODEL = { modelId: "fake-embed", provider: "fake" };

// Two clearly distinct topics, enough sentences to exercise valley detection.
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

async function* asAsyncStream(
  text: string,
  pieceSize = 16
): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += pieceSize) {
    await Promise.resolve();
    yield text.slice(i, i + pieceSize);
  }
}

// ── toEmbedFunction — the load-bearing adapter seam ──────────────────────────

describe("toEmbedFunction", () => {
  it("batches every text into a single embedMany call and unwraps embeddings", async () => {
    const source = { embedding: vi.fn(() => FAKE_MODEL) } as never;
    const embed = toEmbedFunction(source);

    const vectors = await embed(["alpha", "beta", "gamma"]);

    expect(mockEmbedMany).toHaveBeenCalledTimes(1);
    expect(mockEmbedMany.mock.calls[0]?.[0]).toMatchObject({
      model: FAKE_MODEL,
      values: ["alpha", "beta", "gamma"],
    });
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(fakeEmbed("alpha"));
  });

  it("resolves the model from the source with the requested id", async () => {
    const embedding = vi.fn(() => FAKE_MODEL);
    const source = { embedding } as never;
    await toEmbedFunction(source, { model: "my-embed-model" })(["x"]);
    expect(embedding).toHaveBeenCalledWith("my-embed-model");
  });

  it("threads the abort signal through to embedMany", async () => {
    const controller = new AbortController();
    const source = { embedding: () => FAKE_MODEL } as never;
    await toEmbedFunction(source, { abortSignal: controller.signal })(["x"]);
    expect(mockEmbedMany.mock.calls[0]?.[0]).toMatchObject({
      abortSignal: controller.signal,
    });
  });
});

// ── semanticChunk — end-to-end through the real SemanticChunker ──────────────

describe("semanticChunk", () => {
  const source = { embedding: () => FAKE_MODEL } as never;

  it("splits a two-topic document at the semantic boundary", async () => {
    const chunks = await semanticChunk(TWO_TOPIC, source, { chunkSize: 256 });
    expect(chunks.length).toBeGreaterThan(1);
    // The embedder was actually consumed for boundary detection.
    expect(mockEmbedMany).toHaveBeenCalled();
  });

  it("preserves full coverage (join === original)", async () => {
    const chunks = await semanticChunk(TWO_TOPIC, source, { chunkSize: 256 });
    expect(chunks.map((c) => c.text).join("")).toBe(TWO_TOPIC);
  });

  it("reports tokenCount but leaves the embedding slot empty (consumes, not emits)", async () => {
    const chunks = await semanticChunk(TWO_TOPIC, source, { chunkSize: 256 });
    expect(chunks.every((c) => c.tokenCount > 0)).toBe(true);
    expect(chunks.every((c) => c.embedding === undefined)).toBe(true);
  });
});

// ── streamable sources — buffer-then-stream parity, both chunkers ────────────

describe("streamable sources", () => {
  const source = { embedding: () => FAKE_MODEL } as never;

  it("collectSource accumulates an async stream back into the source text", async () => {
    expect(await collectSource(asAsyncStream(TWO_TOPIC))).toBe(TWO_TOPIC);
  });

  it("semanticChunkStream from a stream equals the one-shot result", async () => {
    const opts = { chunkSize: 256 } as const;
    const oneShot = await semanticChunk(TWO_TOPIC, source, opts);
    const streamed = await collect(
      semanticChunkStream(asAsyncStream(TWO_TOPIC), source, opts)
    );
    expect(streamed).toEqual(oneShot);
  });

  it("recursiveChunkStream from a stream equals the one-shot result", async () => {
    const oneShot = await recursiveChunk(TWO_TOPIC, { chunkSize: 128 });
    const streamed = await collect(
      recursiveChunkStream(asAsyncStream(TWO_TOPIC), { chunkSize: 128 })
    );
    expect(streamed).toEqual(oneShot);
  });
});
