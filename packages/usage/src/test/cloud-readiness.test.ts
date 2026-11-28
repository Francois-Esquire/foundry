import { join } from "node:path";

import {
  defineProvider,
  listPrices,
  spendCap,
  window,
} from "@foundry/usage/provider";
import { describe, expect, it, vi } from "vitest";

import { createAnthropic } from "../providers/anthropic";
import { jsonLines } from "../providers/machine";
import { createOpenAI } from "../providers/openai";
import { createUsage, mapWithConcurrency } from "../usage";
import { tempHome } from "./helpers/home";

const FIXED_NOW = new Date("2026-10-15T12:00:00Z");

describe("cloud-native Usage options and seams", () => {
  it("uses injected clock, skips history when history: false, hides credential, and supports remove + queryAccount", async () => {
    const historyCalls: Date[] = [];
    const provider = defineProvider({
      credential: ({ id }: { readonly id: string }) => id,
      history: async (_id, since) => {
        historyCalls.push(since);
        return {
          bySession: [],
          since,
          total: { outputTokens: 5 },
        };
      },
      id: "cloud",
      limits: async () => ({
        limits: [
          window.weekly({
            resetsAt: new Date("2026-10-20T12:00:00Z"),
            usedPercent: 25,
          }),
        ],
      }),
    });

    expect("capabilities" in provider).toBe(false);

    const usage = createUsage({ clock: () => FIXED_NOW });
    const account = provider({ id: "acct-1", name: "acct-1" });
    expect("credential" in account).toBe(false);
    expect(Object.keys(account)).not.toContain("credential");
    usage.add(account);

    const noHistory = await usage.query("acct-1", { history: false });
    expect(noHistory.at).toEqual(FIXED_NOW);
    expect(noHistory.consumption).toBeUndefined();
    expect(historyCalls).toEqual([]);

    const withHistory = await usage.query("acct-1", { since: "1d" });
    expect(withHistory.consumption?.total).toEqual({ outputTokens: 5 });
    expect(historyCalls).toEqual([new Date("2026-10-14T12:00:00Z")]);

    expect(usage.remove("acct-1")).toBe(true);
    expect(usage.remove("acct-1")).toBe(false);
    await expect(usage.query("acct-1")).rejects.toThrow('"acct-1"');

    const stateless = await usage.queryAccount(account, { history: false });
    expect(stateless.name).toBe("acct-1");
    expect(stateless.weekly?.usedPercent).toBe(25);
  });

  it("never exposes credential or plaintext API keys on Anthropic or OpenAI accounts", () => {
    const anthropicAccount = createAnthropic()({
      apiKey: "sk-ant-super-secret",
      name: "ant",
    });
    const openaiAccount = createOpenAI()({
      apiKey: "sk-openai-super-secret",
      name: "oai",
    });
    expect("credential" in anthropicAccount).toBe(false);
    expect("credential" in openaiAccount).toBe(false);
    expect(JSON.stringify(anthropicAccount)).not.toContain("super-secret");
    expect(JSON.stringify(openaiAccount)).not.toContain("super-secret");
  });

  it("validates UsageOptions upfront with RangeError", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createUsage({ concurrency: bad })).toThrow(RangeError);
      expect(() => createUsage({ maxBillingPages: bad })).toThrow(RangeError);
    }
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createUsage({ billingTimeoutMs: bad })).toThrow(RangeError);
    }
    expect(() =>
      createUsage({ billingTimeoutMs: 0.5, concurrency: 1, maxBillingPages: 1 })
    ).not.toThrow();
  });

  it("validates billing baseUrl upfront (https or loopback http, no credentials/query/fragment)", async () => {
    const usage = createUsage({
      clock: () => FIXED_NOW,
      fetch: vi.fn(async () =>
        Response.json({
          data: [{ results: [{ amount: { currency: "usd", value: 4 } }] }],
          has_more: false,
          next_page: null,
        })
      ) as unknown as typeof globalThis.fetch,
    });

    for (const badUrl of [
      "not-a-url",
      "http://billing.example.com",
      "http://localhost.evil.test",
      "ftp://api.openai.com",
      "https://user:pass@api.openai.com",
      "https://api.openai.com?foo=bar",
      "https://api.openai.com?",
      "https://api.openai.com#section",
      "https://api.openai.com#",
    ]) {
      expect(() =>
        usage.add({
          billing: { adminKey: "sk-test", baseUrl: badUrl, cap: 10 },
          name: `bad-${badUrl}`,
          provider: "openai",
        })
      ).toThrow();
    }

    usage.add({
      billing: {
        adminKey: "sk-test",
        baseUrl: "https://billing-proxy.example.test/prefix///",
        cap: 10,
      },
      name: "https-ok",
      provider: "openai",
    });
    usage.add({
      billing: {
        adminKey: "sk-test",
        baseUrl: "http://127.0.0.1:8787/",
        cap: 10,
      },
      name: "loopback-v4",
      provider: "openai",
    });
    usage.add({
      billing: {
        adminKey: "sk-test",
        baseUrl: "http://localhost:8787",
        cap: 10,
      },
      name: "loopback-host",
      provider: "openai",
    });
    usage.add({
      billing: {
        adminKey: "sk-test",
        baseUrl: "http://[::1]:8787/proxy/",
        cap: 10,
      },
      name: "loopback-v6",
      provider: "openai",
    });

    await expect(usage.budget("loopback-v4")).resolves.toMatchObject({
      spent: 4,
    });
  });

  it("trims resolved adminKey and enforces billingTimeoutMs + AbortSignal during adminKey resolution and managedLimits", async () => {
    const authHeaders: (string | null)[] = [];
    const seenSignals: (AbortSignal | undefined)[] = [];
    const fakeFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        authHeaders.push(new Headers(init?.headers).get("authorization"));
        return Response.json({
          data: [{ results: [{ amount: { currency: "usd", value: 10 } }] }],
          has_more: false,
          next_page: null,
        });
      }
    ) as unknown as typeof globalThis.fetch;

    const usage = createUsage({
      billingTimeoutMs: 50,
      clock: () => FIXED_NOW,
      fetch: fakeFetch,
    });
    usage.add({
      billing: {
        adminKey: async (options) => {
          seenSignals.push(options?.signal);
          return "  sk-trimmed-secret\n";
        },
        cap: 100,
      },
      name: "trimmed",
      provider: "openai",
    });
    await expect(usage.budget("trimmed")).resolves.toMatchObject({ spent: 10 });
    expect(authHeaders).toEqual(["Bearer sk-trimmed-secret"]);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);

    // Slow adminKey hits billingTimeoutMs
    usage.add({
      billing: {
        adminKey: () => new Promise<string>(() => undefined),
        cap: 100,
      },
      name: "slow-key",
      provider: "openai",
    });
    const slowKeySnapshot = await usage.query("slow-key", { history: false });
    expect(slowKeySnapshot.failed).toBeDefined();

    // Caller abort during adminKey resolution
    const abortController = new AbortController();
    const abortedRead = usage.query("slow-key", {
      history: false,
      signal: abortController.signal,
    });
    abortController.abort(new Error("caller-aborted"));
    await expect(abortedRead).rejects.toThrow("caller-aborted");

    // Managed billing readSpend honors billingTimeoutMs
    usage.add({
      billing: {
        cap: 100,
        readSpend: () => new Promise(() => undefined),
      },
      name: "slow-managed",
    });
    const slowManaged = await usage.query("slow-managed", { history: false });
    expect(slowManaged.failed).toBeDefined();
  });

  it("validates mapWithConcurrency limit and stops scheduling items after a rejection", async () => {
    for (const bad of [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        mapWithConcurrency([1, 2], bad, async (x) => x)
      ).rejects.toThrow(RangeError);
    }

    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5], 1, async (item) => {
        started.push(item);
        if (item === 2) {
          throw new Error("boom");
        }
        return item;
      })
    ).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
  });

  it("throws on aborted signal in query() even when no accounts match", async () => {
    const usage = createUsage();
    const controller = new AbortController();
    controller.abort(new Error("empty-abort"));
    await expect(usage.query({ signal: controller.signal })).rejects.toThrow(
      "empty-abort"
    );
  });

  it("cleans up billing stub providers on remove() and lets use() replace stubs", async () => {
    const usage = createUsage({ clock: () => FIXED_NOW });
    usage.add({
      billing: { adminKey: "sk-test", cap: 100 },
      name: "org-openai",
      provider: "openai",
    });
    expect(usage.remove("org-openai")).toBe(true);

    const realOpenAI = defineProvider({
      credential: () => null,
      id: "openai",
      limits: async () => ({ limits: [] }),
    });
    expect(() => usage.use(realOpenAI)).not.toThrow();

    // Also verify use() can cleanly replace an active billing stub
    const usage2 = createUsage({ clock: () => FIXED_NOW });
    usage2.add({
      billing: { adminKey: "sk-test", cap: 100 },
      name: "org-openai",
      provider: "openai",
    });
    expect(() => usage2.use(realOpenAI)).not.toThrow();
    // Registering a second real provider with the same id still throws
    expect(() => usage2.use(realOpenAI)).toThrow('"openai" is registered');
  });

  it("handles ENOENT gracefully in jsonLines without crashing", async () => {
    const home = await tempHome();
    const missingFile = join(home, "vanished.jsonl");
    const items: unknown[] = [];
    for await (const entry of jsonLines(missingFile, ['"usage"'])) {
      items.push(entry);
    }
    expect(items).toEqual([]);
  });

  it("caps query concurrency and threads AbortSignal", async () => {
    let active = 0;
    let peak = 0;
    const provider = defineProvider({
      credential: ({ id }: { readonly id: string }) => id,
      id: "bounded",
      limits: async (_id, options) => {
        options?.signal?.throwIfAborted();
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { limits: [] };
      },
    });

    const usage = createUsage({ concurrency: 2 });
    for (const id of ["a", "b", "c", "d", "e"]) {
      usage.add(provider({ id, name: id }));
    }
    const snapshots = await usage.query({ history: false });
    expect(snapshots).toHaveLength(5);
    expect(peak).toBeLessThanOrEqual(2);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      usage.query("a", { signal: controller.signal })
    ).rejects.toThrow("cancelled");
  });

  it("supports async adminKey, custom baseUrl, injected fetch, and maxBillingPages", async () => {
    const requests: { auth: string | null; url: string }[] = [];
    const fakeFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        let url: string;
        if (typeof input === "string") {
          url = input;
        } else if (input instanceof URL) {
          url = input.toString();
        } else {
          ({ url } = input);
        }
        const headers = new Headers(init?.headers);
        requests.push({ auth: headers.get("authorization"), url });
        const page = new URL(url).searchParams.get("page");
        if (!page) {
          return Response.json({
            data: [{ results: [{ amount: { currency: "usd", value: 12.5 } }] }],
            has_more: true,
            next_page: "p2",
          });
        }
        return Response.json({
          data: [{ results: [{ amount: { currency: "usd", value: 7.5 } }] }],
          has_more: false,
          next_page: null,
        });
      }
    ) as unknown as typeof globalThis.fetch;

    const usage = createUsage({
      billingTimeoutMs: 5000,
      clock: () => FIXED_NOW,
      fetch: fakeFetch,
      maxBillingPages: 5,
    });
    usage.add({
      billing: {
        adminKey: async () => "sk-dynamic-secret",
        baseUrl: "https://billing-proxy.example.test/",
        cap: 100,
        projectId: "proj-1",
      },
      name: "org-openai",
      provider: "openai",
    });

    const budget = await usage.budget("org-openai");
    expect(budget).toMatchObject({
      asOf: FIXED_NOW,
      cap: 100,
      remaining: 80,
      spent: 20,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.auth).toBe("Bearer sk-dynamic-secret");
    expect(requests[0]?.url).toContain(
      "https://billing-proxy.example.test/v1/organization/costs"
    );

    const capped = createUsage({
      clock: () => FIXED_NOW,
      fetch: fakeFetch,
      maxBillingPages: 1,
    });
    capped.add({
      billing: {
        adminKey: "sk-static",
        baseUrl: "https://billing-proxy.example.test",
        cap: 100,
      },
      name: "capped-openai",
      provider: "openai",
    });
    const failed = await capped.query("capped-openai", { history: false });
    expect(failed.failed).toContain("maximum page limit of 1");
  });

  it("supports injectable catalog in listPrices without global models.dev state", () => {
    const price = listPrices("anthropic", {
      catalog: {
        "anthropic/claude-test": {
          cost: {
            cache_read: 0.5,
            cache_write: 2,
            input: 3,
            output: 15,
          },
          name: "Claude Test",
        },
      },
    });
    const charge = price("claude-test", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(charge).toEqual({
      amount: { amount: 18, unit: "usd" },
      basis: "priced",
    });
    expect(price("unknown-model", { inputTokens: 100 })).toBeUndefined();
  });

  it("supports managed billing spendCap via budget()", async () => {
    const usage = createUsage({ clock: () => FIXED_NOW });
    const provider = defineProvider({
      credential: () => null,
      id: "managed",
      limits: async () => ({
        limits: [
          spendCap({
            cap: 50,
            resetsAt: new Date("2026-11-01T00:00:00Z"),
            startsAt: new Date("2026-10-01T00:00:00Z"),
            used: 15,
          }),
        ],
      }),
    });
    usage.add(provider({ name: "team" }));
    const budget = await usage.budget("team");
    expect(budget).toMatchObject({
      cap: 50,
      remaining: 35,
      share: 0.7,
      spent: 15,
    });
  });

  it("propagates pre-aborted and mid-flight-aborted AbortSignal in query(), budget(), and share()", async () => {
    const provider = defineProvider({
      credential: () => null,
      id: "abortable",
      limits: async (_cred, options) => {
        options?.signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true }
          );
        });
        return {
          limits: [
            spendCap({
              cap: 100,
              resetsAt: new Date("2026-11-01T00:00:00Z"),
              startsAt: new Date("2026-10-01T00:00:00Z"),
              used: 10,
            }),
            window.weekly({
              resetsAt: new Date("2026-10-20T12:00:00Z"),
              usedPercent: 20,
            }),
          ],
        };
      },
    });
    const usage = createUsage({ clock: () => FIXED_NOW });
    usage.add(provider({ name: "acct" }));

    // Pre-aborted signal
    const preAborted = new AbortController();
    preAborted.abort(new Error("pre-abort"));
    await expect(
      usage.query("acct", { history: false, signal: preAborted.signal })
    ).rejects.toThrow("pre-abort");
    await expect(
      usage.budget("acct", { signal: preAborted.signal })
    ).rejects.toThrow("pre-abort");
    await expect(
      usage.share("acct", "weekly", { signal: preAborted.signal })
    ).rejects.toThrow("pre-abort");

    // Mid-flight-aborted signal
    const midQuery = new AbortController();
    const queryPromise = usage.query("acct", {
      history: false,
      signal: midQuery.signal,
    });
    midQuery.abort(new Error("mid-query-abort"));
    await expect(queryPromise).rejects.toThrow("mid-query-abort");

    const midBudget = new AbortController();
    const budgetPromise = usage.budget("acct", { signal: midBudget.signal });
    midBudget.abort(new Error("mid-budget-abort"));
    await expect(budgetPromise).rejects.toThrow("mid-budget-abort");

    const midShare = new AbortController();
    const sharePromise = usage.share("acct", "weekly", {
      signal: midShare.signal,
    });
    midShare.abort(new Error("mid-share-abort"));
    await expect(sharePromise).rejects.toThrow("mid-share-abort");
  });
});
