import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLanguageModel = vi.fn();
const mockEmbeddingModel = vi.fn();
const mockImageModel = vi.fn();
const mockCreateGateway = vi.fn(() => ({
  embeddingModel: mockEmbeddingModel,
  imageModel: mockImageModel,
  languageModel: mockLanguageModel,
}));
const mockExtractReasoningMiddleware = vi.fn(() => ({ tag: "think" }));
const mockWrapLanguageModel = vi.fn(({ model }: { model: unknown }) => model);

vi.mock("ai", () => ({
  createGateway: mockCreateGateway,
  extractReasoningMiddleware: mockExtractReasoningMiddleware,
  wrapLanguageModel: mockWrapLanguageModel,
}));

const { vercelModels, vercelProvider } = await import("../vercel");
const { Models } = await import("../models");

const FAKE_MODEL = { modelId: "any", provider: "vercel" };

beforeEach(() => {
  mockCreateGateway.mockClear();
  mockLanguageModel.mockReset().mockReturnValue(FAKE_MODEL);
  mockEmbeddingModel.mockReset().mockReturnValue({ tag: "em" });
  mockExtractReasoningMiddleware.mockClear();
  mockWrapLanguageModel.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe("vercelModels", () => {
  it("fetches the configured listing with scoped credentials and normalizes supported model kinds", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            context_window: 10_000,
            id: "vendor/chat",
            max_tokens: 1000,
            pricing: {
              input: "0.000001",
              input_cache_read: "0.0000005",
              input_tiers: [{ cost: "0.000001", max: 5000 }],
              output: "0.000003",
            },
            tags: ["tool-use"],
            type: "language",
          },
          { id: "vendor/embed", type: "embedding" },
          { id: "vendor/image", type: "image" },
          { id: "vendor/video", type: "video" },
        ],
      })
    );
    vi.stubGlobal("fetch", fetch);
    const { signal } = new AbortController();
    const rows = await vercelModels(
      { apiKey: "scoped-key", baseURL: "https://catalog.example/gateway/v1/" },
      { signal }
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://catalog.example/gateway/v1/models",
      { headers: { Authorization: "Bearer scoped-key" }, signal }
    );
    expect(rows.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "vendor/chat", kind: "text" },
      { id: "vendor/embed", kind: "embedding" },
      { id: "vendor/image", kind: "image" },
    ]);
    expect(rows[0]).toMatchObject({
      capabilities: { functionCalling: true },
      costs: {
        cachedInput: 0.5,
        input: 1,
        inputTiers: [{ costPer1M: 1, maxTokens: 5000, minTokens: 0 }],
        output: 3,
      },
      limits: { maxInputTokens: 10_000, maxOutputTokens: 1000 },
    });
    expect(mockCreateGateway).not.toHaveBeenCalled();
  });

  it("uses the public listing without a credential and accepts an empty catalog", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    await expect(vercelModels()).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://ai-gateway.vercel.sh/v1/models",
      { headers: {} }
    );
  });

  it.each([
    [
      new Response("sensitive response", { status: 403 }),
      "GET /models answered 403",
    ],
    [
      new Response("invalid json"),
      "GET /models answered without a valid Vercel model list",
    ],
    [
      Response.json({
        data: [{ id: "vendor/chat", tags: 42, type: "language" }],
      }),
      "GET /models answered without a valid Vercel model list",
    ],
  ])("rejects failed or malformed responses", async (response, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(vercelModels()).rejects.toMatchObject({ message });
  });

  it("propagates cancellation while reading the response body", async () => {
    const controller = new AbortController();
    const reason = new Error("listing cancelled");
    const json = () => {
      controller.abort(reason);
      return Promise.reject(reason);
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json, ok: true }));
    await expect(vercelModels({}, { signal: controller.signal })).rejects.toBe(
      reason
    );
  });
});

describe("vercelProvider", () => {
  it("builds the gateway once and dispatches models against it", () => {
    const provider = vercelProvider({ config: { apiKey: "k" } });
    expect(mockCreateGateway).toHaveBeenCalledTimes(1);
    expect(provider.available).toBe(true);

    expect(provider.languageModel("openai/gpt-5-mini")).toBe(FAKE_MODEL);
    expect(mockLanguageModel).toHaveBeenCalledWith("openai/gpt-5-mini");
    provider.embeddingModel?.("openai/text-embedding-3-small");
    expect(mockEmbeddingModel).toHaveBeenCalledWith(
      "openai/text-embedding-3-small"
    );
  });

  it("is unavailable without a key", () => {
    expect(vercelProvider().available).toBe(false);
    expect(vercelProvider({ config: { apiKey: "k" } }).available).toBe(true);
  });

  it("wraps gateway models with the <think> reasoning extractor", () => {
    vercelProvider({ config: { apiKey: "k" } }).languageModel("m");
    expect(mockExtractReasoningMiddleware).toHaveBeenCalledWith({
      tagName: "think",
    });
    expect(mockWrapLanguageModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: FAKE_MODEL })
    );
  });

  it("resolves explicitly supplied models and defaults through the manager", () => {
    const manager = new Models({
      providers: [
        vercelProvider({
          config: { apiKey: "k" },
          defaults: { text: "vendor/preferred" },
          models: [
            { id: "vendor/first", kind: "text", modelId: "vendor/first" },
            {
              id: "vendor/preferred",
              kind: "text",
              modelId: "vendor/preferred",
            },
            { id: "vendor/embed", kind: "embedding", modelId: "vendor/embed" },
          ],
        }),
      ],
    });
    manager.resolve("text").open();
    manager.resolve("embedding").open();
    expect(mockLanguageModel).toHaveBeenCalledWith("vendor/preferred");
    expect(mockEmbeddingModel).toHaveBeenCalledWith("vendor/embed");
  });

  it("has no fallback catalog or default when none is supplied", () => {
    const provider = vercelProvider({ config: { apiKey: "k" } });
    expect(provider.models).toEqual([]);
    expect(provider.defaults).toBeUndefined();
  });
});
