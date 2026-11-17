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

const { vercelProvider } = await import("../vercel");
const { VERCEL_DEFAULT_MODELS } = await import("../catalog/defaults");
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

  it("through the manager, the catalog default and embedding row resolve", () => {
    const manager = new ModelManager({
      providers: [vercelProvider({ config: { apiKey: "k" } })],
    });
    manager.resolve("text").open();
    manager.resolve("embedding").open();
    expect(mockLanguageModel).toHaveBeenCalledWith("openai/gpt-5.6-luna");
    expect(mockEmbeddingModel).toHaveBeenCalledWith(
      "openai/text-embedding-3-small"
    );
  });

  it("ships a floor with no price of its own: models.dev prices it at run time", () => {
    for (const row of VERCEL_DEFAULT_MODELS) {
      expect(row.costs).toBeUndefined();
    }
  });
});
