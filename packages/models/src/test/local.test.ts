import type * as AiModule from "ai";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLanguageModel = vi.fn((_id: string, _opts?: unknown) => ({
  tag: "lm",
}));
const mockEmbeddingModel = vi.fn((_id: string, _opts?: unknown) => ({
  tag: "em",
}));
const mockTranscriptionModel = vi.fn((_id: string, _opts?: unknown) => ({
  tag: "tm",
}));

vi.mock("@browser-ai/transformers-js", () => ({
  transformersJS: {
    embeddingModel: mockEmbeddingModel,
    languageModel: mockLanguageModel,
    transcriptionModel: mockTranscriptionModel,
  },
}));

// The raw ASR path (LocalProvider.transcribe) loads a real HF pipeline; mock it
// so the test exercises our audio normalization + segment extraction.
const mockAsrPipe = vi.fn(() =>
  Promise.resolve({
    chunks: [
      { text: "hello", timestamp: [0, 1] },
      { text: "world", timestamp: [1, 2] },
    ],
    text: "hello world",
  })
);
const mockPipeline = vi.fn(() => Promise.resolve(mockAsrPipe));

vi.mock("@huggingface/transformers", () => ({
  env: {},
  pipeline: mockPipeline,
}));

// Override only `embed` (used to warm the embedding pipeline in preload);
// keep the rest of `ai` real so the wrapLanguageModel path is unaffected.
const mockEmbed = vi.fn(() =>
  Promise.resolve({ embedding: [0], usage: { tokens: 0 } })
);
vi.mock("ai", async (orig) => {
  const actual = await orig<typeof AiModule>();
  return { ...actual, embed: mockEmbed };
});

// Capture the download trace seam so tests can assert the provider feeds the
// logger correctly; the trace's own lifecycle is covered in logger.test.ts.
const mockTraceTrack = vi.fn();
const mockTraceFinish = vi.fn();
const mockTraceModelDownload = vi.fn(() => ({
  finish: mockTraceFinish,
  track: mockTraceTrack,
}));
vi.mock("../logger", () => ({
  traceModelDownload: mockTraceModelDownload,
}));

const { LOCAL_DEFAULT_MODELS, LOCAL_DEFAULTS, LocalProvider } = await import(
  "../local"
);
const { resolveDefinition } = await import("../provider");

const anyFunction: unknown = expect.any(Function);

const findRow = (id: string) => {
  const row = LOCAL_DEFAULT_MODELS.find((m) => m.id === id);
  if (!row) {
    throw new Error(`Missing catalog row "${id}" in LOCAL_DEFAULT_MODELS`);
  }
  return row;
};
const RUNTIME_DEFAULT = findRow(LOCAL_DEFAULTS.text ?? "text");
const CATALOG_TEXT = findRow("text");
const CATALOG_TEXT_LARGE = findRow("text-large");

type Local = InstanceType<typeof LocalProvider>;
/** Catalog-id resolution, as the manager performs it before calling the provider. */
const text = (p: Local, id?: string) =>
  p.languageModel(resolveDefinition(p, "text", id).modelId);
const embedding = (p: Local, id?: string) =>
  p.embeddingModel(resolveDefinition(p, "embedding", id).modelId);
const transcription = (p: Local, id?: string) =>
  p.transcriptionModel(resolveDefinition(p, "transcription", id).modelId);

const lastSettings = () =>
  mockLanguageModel.mock.calls.at(-1)?.[1] as
    | { rawInitProgressCallback?: (info: unknown) => void }
    | undefined;

beforeEach(() => {
  mockLanguageModel.mockClear();
  mockEmbeddingModel.mockClear();
  mockTranscriptionModel.mockClear();
  mockTraceTrack.mockClear();
  mockTraceFinish.mockClear();
  mockTraceModelDownload.mockClear();
  // Caches are class-level (shared across instances) so a stale entry from a
  // prior test would short-circuit the upstream factory.
  LocalProvider.clearCache();
});

describe("LocalProvider", () => {
  it("is always available — on-device inference needs no credentials", () => {
    expect(new LocalProvider().available).toBe(true);
    expect(new LocalProvider().offline).toBe(true);
  });

  it("resolves the runtime default named by LOCAL_DEFAULTS.text", () => {
    text(new LocalProvider());
    expect(mockLanguageModel).toHaveBeenCalledWith(
      RUNTIME_DEFAULT.modelId,
      expect.objectContaining({
        ...(RUNTIME_DEFAULT.settings ?? {}),
        rawInitProgressCallback: anyFunction,
      })
    );
  });

  it("routes catalog ids to their rows with the row's settings", () => {
    const provider = new LocalProvider();
    text(provider, "text");
    expect(mockLanguageModel).toHaveBeenCalledWith(
      CATALOG_TEXT.modelId,
      expect.objectContaining({
        ...(CATALOG_TEXT.settings ?? {}),
        rawInitProgressCallback: anyFunction,
      })
    );
    text(provider, "text-large");
    expect(mockLanguageModel).toHaveBeenCalledWith(
      CATALOG_TEXT_LARGE.modelId,
      expect.objectContaining({
        ...(CATALOG_TEXT_LARGE.settings ?? {}),
        rawInitProgressCallback: anyFunction,
      })
    );
    text(provider, "text-small");
    expect(mockLanguageModel).toHaveBeenCalledWith(
      "HuggingFaceTB/SmolLM2-360M-Instruct",
      expect.objectContaining({ dtype: "q4" })
    );
  });

  it("embedding and transcription pick the catalog defaults", () => {
    const provider = new LocalProvider();
    embedding(provider);
    transcription(provider);
    expect(mockEmbeddingModel).toHaveBeenCalledWith(
      "Xenova/all-MiniLM-L6-v2",
      expect.objectContaining({ rawInitProgressCallback: anyFunction })
    );
    expect(mockTranscriptionModel).toHaveBeenCalledWith(
      "Xenova/whisper-base.en",
      expect.objectContaining({ rawInitProgressCallback: anyFunction })
    );
  });

  it("unknown ids pass through as upstream ids", () => {
    text(new LocalProvider(), "custom/some-model");
    expect(mockLanguageModel).toHaveBeenCalledWith(
      "custom/some-model",
      expect.objectContaining({ rawInitProgressCallback: anyFunction })
    );
  });

  it("kind validation still applies for known catalog ids", () => {
    expect(() => text(new LocalProvider(), "embed")).toThrow(
      /is kind "embedding", expected "text"/
    );
  });

  it("emits and caches download progress when the bound callback fires", () => {
    const provider = new LocalProvider();
    const events: unknown[] = [];
    provider.events.on("download-progress", (event) => {
      events.push(event);
    });

    text(provider);
    lastSettings()?.rawInitProgressCallback?.({
      file: "model.onnx_data",
      loaded: 100,
      name: "onnx-community/Qwen3-0.6B-ONNX",
      progress: 42,
      status: "progress",
      total: 240,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      file: "model.onnx_data",
      modelId: RUNTIME_DEFAULT.modelId,
      progress: 42,
      status: "progress",
    });
    expect(provider.latestProgress).toMatchObject({ progress: 42 });
  });

  it("transcribe() returns text with timestamped segments from the raw pipeline", async () => {
    const provider = new LocalProvider();
    const result = await provider.transcribe(new Float32Array(16_000));

    expect(mockPipeline).toHaveBeenCalledWith(
      "automatic-speech-recognition",
      expect.any(String),
      expect.objectContaining({ progress_callback: anyFunction })
    );
    expect(result.text).toBe("hello world");
    expect(result.segments).toEqual([
      { end: 1, start: 0, text: "hello" },
      { end: 2, start: 1, text: "world" },
    ]);
  });

  it("aggregates progress across the multiple files a model pulls", () => {
    const provider = new LocalProvider();
    text(provider);
    const fire = lastSettings()?.rawInitProgressCallback;
    fire?.({ file: "weights.onnx", progress: 80, status: "progress" });
    fire?.({ file: "tokenizer.json", progress: 20, status: "progress" });

    expect(provider.aggregateProgress(RUNTIME_DEFAULT.modelId)).toBeCloseTo(
      0.5,
      6
    );
    expect(provider.progress(LOCAL_DEFAULTS.text ?? "text")).toBeCloseTo(
      0.5,
      6
    );
    expect(provider.downloadFiles(RUNTIME_DEFAULT.modelId)).toHaveLength(2);

    fire?.({ file: "weights.onnx", status: "done" });
    fire?.({ status: "ready" });
    expect(provider.aggregateProgress(RUNTIME_DEFAULT.modelId)).toBeNull();
  });

  it("reports status: idle by default, downloading while files are in flight", () => {
    const provider = new LocalProvider();
    expect(provider.status()).toEqual({ progress: 0, state: "idle" });

    text(provider);
    lastSettings()?.rawInitProgressCallback?.({
      file: "weights.onnx",
      progress: 60,
      status: "progress",
    });
    expect(provider.status()).toEqual({ progress: 0.6, state: "downloading" });
  });

  it("preload() warms both pipelines and reports ready, memoizing the run", async () => {
    mockEmbed.mockClear();
    const provider = new LocalProvider();
    await provider.preload();
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(provider.status()).toEqual({ progress: 1, state: "ready" });
    await provider.preload();
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it("preload() reports error when a pipeline fails to warm", async () => {
    mockEmbed.mockRejectedValueOnce(new Error("embedding boom"));
    const provider = new LocalProvider();
    await expect(provider.preload()).rejects.toThrow("embedding boom");
    expect(provider.status()).toEqual({ progress: 0, state: "error" });
  });

  it("does not let initiate/download events overwrite the cached progress with 0%", () => {
    const provider = new LocalProvider();
    text(provider);
    const fire = lastSettings()?.rawInitProgressCallback;
    fire?.({
      file: "model.onnx_data",
      loaded: 200,
      progress: 78,
      status: "progress",
      total: 256,
    });
    fire?.({ file: "tokenizer.json", status: "initiate" });
    fire?.({ file: "tokenizer.json", status: "download" });
    expect(provider.latestProgress).toMatchObject({
      file: "model.onnx_data",
      progress: 78,
    });
  });

  it("clears cached progress at `done`, at 100%, and at `ready`", () => {
    const provider = new LocalProvider();
    text(provider);
    const fire = lastSettings()?.rawInitProgressCallback;

    fire?.({ file: "a", progress: 60, status: "progress" });
    fire?.({ file: "a", status: "done" });
    expect(provider.latestProgress).toBeNull();

    fire?.({ file: "b", progress: 100, status: "progress" });
    expect(provider.latestProgress).toBeNull();

    fire?.({ file: "c", progress: 50, status: "progress" });
    fire?.({ status: "ready" });
    expect(provider.latestProgress).toBeNull();
  });

  it("marks the model loaded on a terminal download event and emits `model-loaded`", () => {
    const provider = new LocalProvider();
    const loadedEvents: unknown[] = [];
    provider.events.on("model-loaded", (event) => {
      loadedEvents.push(event);
    });
    expect(provider.loadedModel).toBeNull();

    text(provider);
    lastSettings()?.rawInitProgressCallback?.({
      model: RUNTIME_DEFAULT.modelId,
      status: "ready",
      task: "text-generation",
    });

    expect(provider.loadedModel).toEqual({
      kind: RUNTIME_DEFAULT.kind ?? "text",
      label: RUNTIME_DEFAULT.label,
      modelId: RUNTIME_DEFAULT.modelId,
      ...((RUNTIME_DEFAULT.settings as { dtype?: string } | undefined)?.dtype
        ? { dtype: (RUNTIME_DEFAULT.settings as { dtype: string }).dtype }
        : {}),
    });
    expect(loadedEvents).toHaveLength(1);
    expect(loadedEvents[0]).toEqual(provider.loadedModel);
  });

  it("opens one download trace per binding, feeds it every tick, and finishes at terminals", () => {
    const provider = new LocalProvider();
    text(provider);

    expect(mockTraceModelDownload).toHaveBeenCalledTimes(1);
    expect(mockTraceModelDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: RUNTIME_DEFAULT.kind ?? "text",
        modelId: RUNTIME_DEFAULT.modelId,
      })
    );

    const fire = lastSettings()?.rawInitProgressCallback;
    fire?.({
      file: "model.onnx",
      loaded: 10,
      progress: 10,
      status: "progress",
      total: 100,
    });
    fire?.({ file: "model.onnx", status: "done" });
    fire?.({ status: "ready" });

    expect(mockTraceTrack).toHaveBeenCalledTimes(3);
    expect(mockTraceFinish).toHaveBeenCalledTimes(2);
    expect(mockTraceFinish).toHaveBeenNthCalledWith(1, "done");
    expect(mockTraceFinish).toHaveBeenNthCalledWith(2, "ready");
  });

  it("memoizes per upstream modelId, class-wide, for every kind", () => {
    const a = new LocalProvider();
    const b = new LocalProvider();

    expect(text(a)).toBe(text(a));
    // A second instance (dev hot-reload, stray boot) must not double the
    // loaded weights in RAM.
    expect(text(a)).toBe(text(b));
    expect(mockLanguageModel).toHaveBeenCalledTimes(1);

    expect(embedding(a)).toBe(embedding(a));
    expect(transcription(a)).toBe(transcription(a));
    expect(mockEmbeddingModel).toHaveBeenCalledTimes(1);
    expect(mockTranscriptionModel).toHaveBeenCalledTimes(1);
  });

  it("chains a caller-supplied rawInitProgressCallback alongside the emitter", () => {
    const userCallback = vi.fn();
    const provider = new LocalProvider({
      defaults: { text: "text" },
      models: [
        {
          id: "text",
          kind: "text",
          modelId: "user/custom",
          settings: { rawInitProgressCallback: userCallback },
        },
      ],
    });

    text(provider);
    lastSettings()?.rawInitProgressCallback?.({
      model: "user/custom",
      status: "ready",
      task: "text-generation",
    });
    expect(userCallback).toHaveBeenCalledTimes(1);
  });

  it("download() rejects an unknown catalog id", async () => {
    await expect(new LocalProvider().download("ghost")).rejects.toThrow(
      /not registered/
    );
  });
});
