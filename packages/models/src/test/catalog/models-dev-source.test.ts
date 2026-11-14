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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("holdModelsDev", () => {
  it("fetches models.dev once per process when it loads, and keeps the catalog", async () => {
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
    const offline = failed.holdModelsDev();
    await expect(offline.loaded).resolves.toBeUndefined();
    expect(failed.loadedModelsDev()).toBeUndefined();
    offline.release();

    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 }))
    );
    const refused = await source();
    const busy = refused.holdModelsDev();
    await expect(busy.loaded).resolves.toBeUndefined();
    busy.release();
  });

  it("retries a failed fetch with a growing delay while a hold remains, and stops once one loads", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn(async (_url: string) => Response.json(PAYLOAD))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { holdModelsDev, loadedModelsDev } = await source();

    const hold = holdModelsDev();
    await expect(hold.loaded).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(loadedModelsDev()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(loadedModelsDev()?.["openai/gpt-5-mini"]).toBeDefined();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    hold.release();
  });

  it("caps the retry delay at 10 minutes", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => Promise.reject(new Error("offline")));
    vi.stubGlobal("fetch", fetch);
    const { holdModelsDev } = await source();

    const hold = holdModelsDev();
    await hold.loaded;
    // 30 s, 1, 2, 4 and 8 minutes, then 10 minutes each time.
    for (const delay of [30, 60, 120, 240, 480, 600, 600]) {
      await vi.advanceTimersByTimeAsync(delay * 1000);
    }
    expect(fetch).toHaveBeenCalledTimes(8);
    hold.release();
  });

  it("cancels a waiting retry when the last hold is released, and a new hold tries at once", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => Promise.reject(new Error("offline")));
    vi.stubGlobal("fetch", fetch);
    const { holdModelsDev } = await source();

    const first = holdModelsDev();
    await first.loaded;
    expect(vi.getTimerCount()).toBe(1);
    first.release();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    const second = holdModelsDev();
    expect(fetch).toHaveBeenCalledTimes(2);
    await second.loaded;
    // A new hold does not wait for the retry.
    const third = holdModelsDev();
    expect(fetch).toHaveBeenCalledTimes(3);
    await third.loaded;
    second.release();
    third.release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps nothing from an aborted fetch that completes after its replacement loaded", async () => {
    const late = Promise.withResolvers<unknown>();
    const fetch = vi
      .fn(async (_url: string) =>
        Response.json({
          ...PAYLOAD,
          providers: {
            openai: {
              models: { "gpt-5-mini": { cost: { input: 99, output: 2 } } },
            },
          },
        })
      )
      .mockResolvedValueOnce({
        json: () => late.promise,
        ok: true,
      } as unknown as Response);
    vi.stubGlobal("fetch", fetch);
    const { holdModelsDev, loadedModelsDev } = await source();

    const abandoned = holdModelsDev();
    // The response has arrived; its body is still being read.
    await Promise.resolve();
    abandoned.release();
    const replacement = holdModelsDev();
    await replacement.loaded;
    expect(loadedModelsDev()?.["openai/gpt-5-mini"]?.cost?.input).toBe(99);

    late.resolve(PAYLOAD);
    await expect(abandoned.loaded).resolves.toBeUndefined();
    expect(loadedModelsDev()?.["openai/gpt-5-mini"]?.cost?.input).toBe(99);
    replacement.release();
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
