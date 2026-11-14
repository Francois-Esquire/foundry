import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PAYLOAD = {
  models: { "openai/gpt-5-mini": { name: "GPT-5 mini" } },
  providers: {
    openai: { models: { "gpt-5-mini": { cost: { input: 0.25, output: 2 } } } },
  },
};

/** A fresh module, so each test starts with nothing loaded. */
const source = () => import("../../catalog/models-dev-source");

/** A fetch that answers only when its signal aborts, as a hung server would. */
const hanging = () =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      })
  );

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("holdModelsDev", () => {
  it("fetches models.dev once per process and keeps the catalog", async () => {
    const fetch = vi.fn(async (_url: string) => Response.json(PAYLOAD));
    vi.stubGlobal("fetch", fetch);
    const { holdModelsDev, loadedModelsDev } = await source();

    expect(loadedModelsDev()).toBeUndefined();
    const first = holdModelsDev();
    const second = holdModelsDev();
    const catalog = await first.loaded;
    expect(await second.loaded).toBe(catalog);
    first.release();
    second.release();
    await holdModelsDev().loaded;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://models.dev/catalog.json");
    expect(catalog?.["openai/gpt-5-mini"]?.cost).toEqual({
      input: 0.25,
      output: 2,
    });
    expect(loadedModelsDev()).toBe(catalog);
  });

  it("aborts the fetch when the last hold is released, and a later hold starts it again", async () => {
    const fetch = hanging();
    vi.stubGlobal("fetch", fetch);
    const { holdModelsDev, loadedModelsDev } = await source();

    const first = holdModelsDev();
    const second = holdModelsDev();
    first.release();
    first.release();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    second.release();
    await expect(first.loaded).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(loadedModelsDev()).toBeUndefined();

    fetch.mockImplementation(async () => Response.json(PAYLOAD));
    const again = holdModelsDev();
    expect((await again.loaded)?.["openai/gpt-5-mini"]).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("leaves no catalog and throws nothing when the fetch fails or is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );
    const failed = await source();
    await expect(failed.holdModelsDev().loaded).resolves.toBeUndefined();
    expect(failed.loadedModelsDev()).toBeUndefined();

    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 }))
    );
    const refused = await source();
    await expect(refused.holdModelsDev().loaded).resolves.toBeUndefined();
  });

  it("reads FOUNDRY_MODELS_DEV_URL, and loads nothing when it is empty", async () => {
    const fetch = vi.fn(async (_url: string) => Response.json(PAYLOAD));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("FOUNDRY_MODELS_DEV_URL", "http://mirror.test/catalog.json");
    await (await source()).holdModelsDev().loaded;
    expect(fetch.mock.calls[0]?.[0]).toBe("http://mirror.test/catalog.json");

    vi.resetModules();
    vi.stubEnv("FOUNDRY_MODELS_DEV_URL", "");
    await expect(
      (await source()).holdModelsDev().loaded
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
