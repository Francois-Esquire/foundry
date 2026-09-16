import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { vercelProvider, VERCEL_DEFAULT_MODELS } = await import("../vercel");
const { ModelManager } = await import("../manager");

const FAKE_MODEL = { modelId: "any", provider: "vercel" };

beforeEach(() => {
  mockCreateGateway.mockClear();
  mockLanguageModel.mockReset().mockReturnValue(FAKE_MODEL);
  mockEmbeddingModel.mockReset().mockReturnValue({ tag: "em" });
  mockExtractReasoningMiddleware.mockClear();
  mockWrapLanguageModel.mockClear();
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

  it("is unavailable without a key and rebuilds on configure()", () => {
    const provider = vercelProvider();
    expect(provider.available).toBe(false);
    provider.configure?.({ apiKey: "k" });
    expect(provider.available).toBe(true);
    expect(mockCreateGateway).toHaveBeenCalledTimes(2);
    expect(mockCreateGateway).toHaveBeenLastCalledWith({
      apiKey: "k",
      baseURL: undefined,
    });
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

  it("through the manager, the catalog default and embedding row resolve", () => {
    const manager = new ModelManager({
      providers: [vercelProvider({ config: { apiKey: "k" } })],
    });
    manager.model();
    manager.embedding();
    expect(mockLanguageModel).toHaveBeenCalledWith("openai/gpt-5.6-luna");
    expect(mockEmbeddingModel).toHaveBeenCalledWith(
      "openai/text-embedding-3-small"
    );
  });

  it("ships a priced floor", () => {
    const luna = VERCEL_DEFAULT_MODELS.find(
      (m) => m.id === "openai/gpt-5.6-luna"
    );
    expect(luna?.costs).toEqual({
      cachedInput: 0.02,
      cacheWrite: 0.25,
      input: 0.2,
      output: 1.2,
    });
  });
});

describe("vercelProvider — discovery", () => {
  const payload = {
    data: [
      {
        context_window: 1_000_000,
        id: "alibaba/qwen3.5-flash",
        max_tokens: 64_000,
        name: "Qwen 3.5 Flash",
        pricing: { input: "0.0000001", output: "0.0000004" },
        tags: ["vision", "reasoning", "tool-use"],
        type: "language",
      },
    ],
  };

  it("fetches the live list from the default gateway URL", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve(payload), ok: true })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = vercelProvider({ config: { apiKey: "k" } });
      const rows = (await provider.discover?.()) ?? [];
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ai-gateway.vercel.sh/v1/models"
      );
      expect(rows[0]).toMatchObject({
        id: "alibaba/qwen3.5-flash",
        limits: { maxInputTokens: 1_000_000 },
      });
      expect(rows[0]?.costs?.input).toBeCloseTo(0.1, 9);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("respects a configured baseURL override", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve(payload), ok: true })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await vercelProvider({
        config: { apiKey: "k", baseURL: "http://proxy/v1/" },
      }).discover?.();
      expect(fetchMock).toHaveBeenCalledWith("http://proxy/v1/models");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats a malformed 200 body as a discovery failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ json: () => Promise.resolve({ nope: 1 }), ok: true })
      )
    );
    try {
      await expect(
        vercelProvider({ config: { apiKey: "k" } }).discover?.()
      ).rejects.toThrow(/malformed/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("through the manager, a failed discovery keeps the floor serving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 500, statusText: "nope" })
      )
    );
    try {
      const provider = vercelProvider({ config: { apiKey: "k" } });
      const manager = new ModelManager({ providers: [provider] });
      await manager.init();
      expect(provider.models).toBe(VERCEL_DEFAULT_MODELS);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
