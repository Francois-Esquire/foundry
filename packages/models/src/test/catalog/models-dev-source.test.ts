import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PAYLOAD = {
  models: { "openai/gpt-5-mini": { name: "GPT-5 mini" } },
  providers: {
    openai: { models: { "gpt-5-mini": { cost: { input: 0.25, output: 2 } } } },
  },
};

/** A fresh module, so each test starts with nothing loaded. */
const source = () => import("../../catalog/models-dev-source");

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("loadModelsDev", () => {
  it("fetches models.dev once per process and keeps the catalog", async () => {
    const fetch = vi.fn(async (_url: string) => Response.json(PAYLOAD));
    vi.stubGlobal("fetch", fetch);
    const { loadedModelsDev, loadModelsDev } = await source();

    expect(loadedModelsDev()).toBeUndefined();
    const [first, second] = await Promise.all([
      loadModelsDev(),
      loadModelsDev(),
    ]);
    await loadModelsDev();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://models.dev/catalog.json");
    expect(first?.["openai/gpt-5-mini"]?.cost).toEqual({
      input: 0.25,
      output: 2,
    });
    expect(second).toBe(first);
    expect(loadedModelsDev()).toBe(first);
  });

  it("leaves no catalog and throws nothing when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );
    const { loadedModelsDev, loadModelsDev } = await source();

    await expect(loadModelsDev()).resolves.toBeUndefined();
    expect(loadedModelsDev()).toBeUndefined();
  });

  it("leaves no catalog when the server refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 }))
    );
    const { loadModelsDev } = await source();

    await expect(loadModelsDev()).resolves.toBeUndefined();
  });

  it("reads FOUNDRY_MODELS_DEV_URL, and loads nothing when it is empty", async () => {
    const fetch = vi.fn(async (_url: string) => Response.json(PAYLOAD));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("FOUNDRY_MODELS_DEV_URL", "http://mirror.test/catalog.json");
    await (await source()).loadModelsDev();
    expect(fetch.mock.calls[0]?.[0]).toBe("http://mirror.test/catalog.json");

    vi.resetModules();
    vi.stubEnv("FOUNDRY_MODELS_DEV_URL", "");
    await expect((await source()).loadModelsDev()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
