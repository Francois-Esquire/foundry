import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeProvider } from "./helpers/model";

const mockLanguageModel = vi.fn(() => ({ tag: "lm" }));
const mockEmbeddingModel = vi.fn(() => ({ tag: "em" }));
const mockTranscriptionModel = vi.fn(() => ({ tag: "tm" }));

vi.mock("@browser-ai/transformers-js", () => ({
  transformersJS: {
    embeddingModel: mockEmbeddingModel,
    languageModel: mockLanguageModel,
    transcriptionModel: mockTranscriptionModel,
  },
}));

/** A remote file that streams until its fetch is aborted. */
function endlessFetch(_input: string | URL, init?: RequestInit) {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new Uint8Array([1]));
      init?.signal?.addEventListener("abort", () =>
        controller.error(init.signal?.reason)
      );
    },
  });
  return Promise.resolve(new Response(body));
}

const transformersEnv: {
  allowRemoteModels?: boolean;
  cacheDir?: string;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
} = { fetch: endlessFetch };
vi.mock("@huggingface/transformers", () => ({
  env: transformersEnv,
  pipeline: vi.fn(() => Promise.resolve(vi.fn())),
}));

const { configureCache, isLocalProvider, LocalProvider } = await import(
  "../local/provider"
);

beforeEach(() => {
  LocalProvider.clearCache();
  mockLanguageModel.mockClear();
  mockEmbeddingModel.mockClear();
  mockTranscriptionModel.mockClear();
  Reflect.deleteProperty(transformersEnv, "allowRemoteModels");
  Reflect.deleteProperty(transformersEnv, "cacheDir");
});

describe("offline per instance", () => {
  it("keeps remote weights off while any local instance is offline", () => {
    const first = new LocalProvider({ id: "first" });
    const second = new LocalProvider({ id: "second" });
    first.setOffline(true);
    second.setOffline(true);
    first.setOffline(false);
    expect(transformersEnv.allowRemoteModels).toBe(false);
    second.setOffline(false);
    expect(transformersEnv.allowRemoteModels).toBe(true);
  });

  it("cuts remote fetches in flight and refuses new ones while any instance is offline", async () => {
    const local = new LocalProvider();
    const response = await transformersEnv.fetch(
      "https://huggingface.co/weights"
    );
    const reader = response.body?.getReader();
    await reader?.read();

    local.setOffline(true);
    await expect(reader?.read()).rejects.toThrow("offline");
    await expect(
      transformersEnv.fetch("https://huggingface.co/weights")
    ).rejects.toThrow("offline");

    await local.dispose();
    expect(transformersEnv.allowRemoteModels).toBe(true);
    await expect(
      transformersEnv.fetch("https://huggingface.co/weights")
    ).resolves.toBeInstanceOf(Response);
  });

  it("keeps remote weights off when the cache is set up after going offline", () => {
    const local = new LocalProvider();
    local.setOffline(true);

    configureCache("/tmp/foundry-models-cache");
    expect(transformersEnv.cacheDir).toBe("/tmp/foundry-models-cache");
    expect(transformersEnv.allowRemoteModels).toBe(false);

    local.setOffline(false);
    expect(transformersEnv.allowRemoteModels).toBe(true);
  });
});

describe("local surface identity", () => {
  it("does not treat a plain provider named local as the local surface", () => {
    expect(isLocalProvider(fakeProvider("local"))).toBe(false);
    expect(isLocalProvider(new LocalProvider({ id: "other" }))).toBe(true);
  });
});
