import type * as AiModule from "ai";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEmbed = vi.fn();
const mockEmbedMany = vi.fn();

// Override only the embed entry points; keep the rest of `ai` real.
vi.mock("ai", async (orig) => {
  const actual = await orig<typeof AiModule>();
  return { ...actual, embed: mockEmbed, embedMany: mockEmbedMany };
});

// embedViaPipeline loads a real HF pipeline; stub it with a fixed vector.
const mockPipe = vi.fn(() =>
  Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3, 0.4]) })
);
const mockPipeline = vi.fn(() => Promise.resolve(mockPipe));
vi.mock("@huggingface/transformers", () => ({
  env: {},
  pipeline: mockPipeline,
}));

// Pulled in transitively via the manager → LocalProvider import chain; its
// real module reads exports off @huggingface/transformers that the stub
// above doesn't provide.
vi.mock("@browser-ai/transformers-js", () => ({
  transformersJS: {
    embeddingModel: vi.fn(),
    languageModel: vi.fn(),
    transcriptionModel: vi.fn(),
  },
}));

const { embed, embedFields, embedViaPipeline } = await import(
  "../../embeddings/text"
);
const { configureModelObservability, withAiLogger } = await import(
  "../../logger"
);

type EmbedSource = Parameters<typeof embed>[0];

interface EmbeddingField {
  count?: number;
  dimensions?: number;
  model?: string;
  tokens?: number;
}

interface AiEvent {
  ai?: { embedding?: EmbeddingField };
}

function drainAiEvents(events: AiEvent[]) {
  configureModelObservability({
    enabled: true,
    logger: {
      drain: (ctx) => {
        events.push(ctx.event as AiEvent);
      },
    },
  });
}

const FAKE_EMBED_MODEL = { modelId: "fake-embed", provider: "fake" };
const source = {
  embedding: () => FAKE_EMBED_MODEL,
} as unknown as EmbedSource;

beforeEach(() => {
  mockEmbed.mockReset().mockResolvedValue({
    embedding: [1, 2, 3],
    usage: { tokens: 5 },
  });
  mockEmbedMany.mockReset().mockResolvedValue({
    embeddings: [[1, 2]],
    usage: { tokens: 9 },
  });
});

afterEach(() => {
  configureModelObservability({ enabled: true });
});

describe("embeddings observability", () => {
  it("embed() folds into the caller's session so ONE wide event spans the whole flow", async () => {
    const events: AiEvent[] = [];
    drainAiEvents(events);

    // The RAG shape: the outer event owns embed + retrieval + generation.
    await withAiLogger({ operation: "rag-chat" }, async (ai) => {
      const vector = await embed(source, "query", { session: ai });
      expect(vector).toEqual([1, 2, 3]);
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.ai?.embedding).toMatchObject({
      dimensions: 3,
      model: "fake-embed",
      tokens: 5,
    });
  });

  it("embed() emits its own self-contained wide event when no session is given", async () => {
    const events: AiEvent[] = [];
    drainAiEvents(events);

    await embed(source, "query");

    expect(events).toHaveLength(1);
    expect(events[0]?.ai?.embedding?.tokens).toBe(5);
  });

  it("normalizes missing or non-finite token usage to 0", async () => {
    const events: AiEvent[] = [];
    drainAiEvents(events);
    mockEmbed.mockResolvedValue({
      embedding: [1, 2],
      usage: { tokens: Number.NaN },
    });

    await embed(source, "query");

    expect(events[0]?.ai?.embedding?.tokens).toBe(0);
  });

  it("embedFields() shares the caller's session too", async () => {
    const events: AiEvent[] = [];
    drainAiEvents(events);

    await withAiLogger({ operation: "index-fields" }, async (ai) => {
      await embedFields(source, [{ field: "title", text: "hello world" }], {
        session: ai,
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.ai?.embedding).toMatchObject({
      count: 1,
      dimensions: 2,
      model: "fake-embed",
      tokens: 9,
    });
  });

  it("embedViaPipeline() emits an instrumented wide event for the raw pipeline path", async () => {
    const events: AiEvent[] = [];
    drainAiEvents(events);

    const vector = await embedViaPipeline("hello");

    expect(vector).toHaveLength(4);
    expect(events).toHaveLength(1);
    expect(events[0]?.ai?.embedding).toMatchObject({
      dimensions: 4,
      model: "Xenova/all-MiniLM-L6-v2",
      tokens: 0,
    });
  });
});
