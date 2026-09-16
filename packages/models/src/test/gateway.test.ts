import { beforeEach, describe, expect, it, vi } from "vitest";

interface OpenAICompatCall {
  modelId: string;
  options: {
    provider: string;
    url: (params: { modelId: string; path: string }) => string;
    headers: () => Record<string, string | undefined>;
  };
}

const chatCalls: OpenAICompatCall[] = [];
const embedCalls: OpenAICompatCall[] = [];
const imageCalls: OpenAICompatCall[] = [];

class FakeChatModel {
  readonly modelId: string;
  constructor(modelId: string, options: OpenAICompatCall["options"]) {
    this.modelId = modelId;
    chatCalls.push({ modelId, options });
  }
}
class FakeEmbeddingModel {
  readonly modelId: string;
  constructor(modelId: string, options: OpenAICompatCall["options"]) {
    this.modelId = modelId;
    embedCalls.push({ modelId, options });
  }
}
class FakeImageModel {
  readonly modelId: string;
  constructor(modelId: string, options: OpenAICompatCall["options"]) {
    this.modelId = modelId;
    imageCalls.push({ modelId, options });
  }
}

vi.mock("@ai-sdk/openai-compatible", () => ({
  OpenAICompatibleChatLanguageModel: FakeChatModel,
  OpenAICompatibleEmbeddingModel: FakeEmbeddingModel,
  OpenAICompatibleImageModel: FakeImageModel,
}));

const { gatewayProvider } = await import("../gateway");
const { ModelManager } = await import("../manager");

beforeEach(() => {
  chatCalls.length = 0;
  embedCalls.length = 0;
  imageCalls.length = 0;
});

describe("gatewayProvider", () => {
  it("available requires both a baseURL and an API key", () => {
    expect(
      gatewayProvider({ config: { baseURL: "http://gw" } }).available
    ).toBe(false);
    expect(
      gatewayProvider({ config: { apiKey: "k", baseURL: "http://gw" } })
        .available
    ).toBe(true);
  });

  it("builds chat, embedding, and image models tagged with its id", () => {
    const provider = gatewayProvider({
      config: { apiKey: "k", baseURL: "http://gw" },
    });
    provider.languageModel("openai/gpt-5-mini");
    provider.embeddingModel?.("openai/text-embedding-3-small");
    provider.imageModel?.("openai/gpt-image-1");

    expect(chatCalls[0]?.modelId).toBe("openai/gpt-5-mini");
    expect(chatCalls[0]?.options.provider).toBe("gateway");
    expect(embedCalls[0]?.modelId).toBe("openai/text-embedding-3-small");
    expect(imageCalls[0]?.modelId).toBe("openai/gpt-image-1");
  });

  it("through the manager, catalog defaults resolve to the real wire ids", () => {
    const manager = new ModelManager({
      providers: [
        gatewayProvider({ config: { apiKey: "k", baseURL: "http://gw" } }),
      ],
    });
    manager.model();
    manager.embedding();
    expect(chatCalls[0]?.modelId).toBe("openai/gpt-5-mini");
    expect(embedCalls[0]?.modelId).toBe("openai/text-embedding-3-small");
  });

  it("url() applies queryParams and trims the trailing slash", () => {
    const provider = gatewayProvider({
      config: { apiKey: "k", baseURL: "http://gw/", queryParams: { v: "1" } },
    });
    provider.languageModel("m");
    const url = chatCalls[0]?.options.url({ modelId: "m", path: "/chat" });
    expect(url).toBe("http://gw/chat?v=1");
  });

  it("headers() includes Authorization + custom headers", () => {
    const provider = gatewayProvider({
      config: { apiKey: "k", baseURL: "http://gw", headers: { "x-a": "b" } },
    });
    provider.languageModel("m");
    expect(chatCalls[0]?.options.headers()).toEqual({
      Authorization: "Bearer k",
      "x-a": "b",
    });
  });

  it("configure() patches credentials so subsequent models see them", () => {
    const provider = gatewayProvider({ config: { baseURL: "http://gw" } });
    expect(provider.available).toBe(false);
    provider.configure?.({ apiKey: "new" });
    expect(provider.available).toBe(true);
    provider.languageModel("m");
    expect(chatCalls[0]?.options.headers().Authorization).toBe("Bearer new");
  });
});
