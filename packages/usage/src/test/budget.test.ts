import { spendCap, window } from "@foundry/usage/provider";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createUsage } from "../usage";

const NOW = new Date("2026-12-19T12:34:56Z");
const START = new Date("2026-12-01T00:00:00Z");
const RESET = new Date("2027-01-01T00:00:00Z");

const fakeAccount = (
  limits: () => Promise<{
    limits: ReturnType<typeof spendCap | typeof window.weekly>[];
  }>
) => ({
  history: vi.fn(),
  limits,
  name: "work",
  provider: { defaultAccount: async () => undefined, id: "fake" },
});

const json = (body: object) => Response.json(body);

const openAICosts = (value: number, next?: string, currency = "usd") =>
  json({
    data: [{ results: [{ amount: { currency, value } }] }],
    has_more: next !== undefined,
    next_page: next ?? null,
  });

const anthropicCosts = (amount: string, refreshedAt: string | null) =>
  json({
    data: refreshedAt
      ? [{ cost: { amount, currency: "USD", list_amount: "90000" } }]
      : [],
    data_refreshed_at: refreshedAt,
    has_more: false,
    next_page: null,
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usage.budget", () => {
  it("reads a reported spend cap without touching history and preserves overages", async () => {
    vi.setSystemTime(NOW);
    let spent = 180;
    const account = fakeAccount(async () => ({
      limits: [
        window.weekly({ usedPercent: 20 }),
        spendCap({ cap: 500, resetsAt: RESET, used: spent }),
      ],
    }));
    const usage = createUsage();
    usage.add(account);
    await expect(usage.budget("work")).resolves.toEqual({
      asOf: NOW,
      cap: 500,
      currency: "USD",
      remaining: 320,
      resetsAt: RESET,
      share: 0.64,
      spent: 180,
    });
    spent = 625;
    await expect(usage.budget("work")).resolves.toMatchObject({
      remaining: 0,
      share: 0,
      spent: 625,
    });
    expect(account.history).not.toHaveBeenCalled();
  });

  it("returns undefined for unknown, allowance-only, failed, and expired readings", async () => {
    vi.setSystemTime(NOW);
    const usage = createUsage();
    usage.add(
      fakeAccount(async () => ({ limits: [window.weekly({ usedPercent: 0 })] }))
    );
    usage.add({
      ...fakeAccount(async () => {
        throw new Error("provider unavailable");
      }),
      name: "failed",
    });
    usage.add({
      ...fakeAccount(async () => ({
        limits: [spendCap({ cap: 100, resetsAt: NOW, used: 100 })],
      })),
      name: "expired",
    });
    for (const name of ["missing", "work", "failed", "expired"]) {
      await expect(usage.budget(name)).resolves.toBeUndefined();
    }
  });

  it("reads one shared weekly budget without a provider and follows its reset", async () => {
    const weekStart = new Date("2026-12-14T00:00:00Z");
    const weekReset = new Date("2026-12-21T00:00:00Z");
    vi.setSystemTime(NOW);
    const readSpend = vi.fn().mockReturnValue({
      resetsAt: weekReset,
      spent: 300,
      startsAt: weekStart,
    });
    const usage = createUsage();
    const name = usage.add({
      billing: { cap: 500, readSpend },
      name: "shared",
    });
    expect(readSpend).not.toHaveBeenCalled();
    await expect(usage.budget(name)).resolves.toMatchObject({
      remaining: 200,
      resetsAt: weekReset,
      share: 0.4,
      spent: 300,
      startsAt: weekStart,
    });
    expect(readSpend).toHaveBeenCalledOnce();

    vi.setSystemTime(weekReset);
    await expect(usage.budget(name)).resolves.toBeUndefined();
    readSpend.mockResolvedValue({
      resetsAt: new Date("2026-12-28T00:00:00Z"),
      spent: 0,
      startsAt: weekReset,
    });
    await expect(usage.budget(name)).resolves.toMatchObject({
      remaining: 500,
      share: 1,
      spent: 0,
      startsAt: weekReset,
    });
  });

  it("includes shared budgets in account queries without assigning them a provider", async () => {
    vi.setSystemTime(NOW);
    const usage = createUsage();
    const account = fakeAccount(async () => ({ limits: [] }));
    usage.add({ ...account, name: account.provider.id });
    const name = usage.add({
      billing: {
        cap: 500,
        readSpend: () => ({ resetsAt: RESET, spent: 300, startsAt: START }),
      },
      name: "shared",
    });
    const snapshot = await usage.query(name);
    expect(snapshot).not.toHaveProperty("provider");
    expect(snapshot.spendCap).toMatchObject({
      headroom: { remaining: 200 },
      used: { amount: 300 },
    });
    expect((await usage.query()).map(({ name: entry }) => entry)).toEqual([
      "fake",
      "shared",
    ]);
    await expect(usage.query({ provider: "fake" })).resolves.toMatchObject([
      { name: "fake", provider: "fake" },
    ]);
    await expect(usage.initialize()).resolves.toMatchObject([{ name: "fake" }]);
  });

  it("totals every OpenAI cost page for the registered project and UTC month", async () => {
    vi.setSystemTime(NOW);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(openAICosts(125.25, "cursor"))
      .mockResolvedValueOnce(openAICosts(54.75));
    vi.stubGlobal("fetch", fetch);
    const usage = createUsage();
    const name = usage.add({
      billing: { adminKey: "test-admin", cap: 500, projectId: "proj_work" },
      name: "work",
      provider: "openai",
    });
    expect(name).toBe("work");
    expect(fetch).not.toHaveBeenCalled();
    await expect(usage.budget(name)).resolves.toEqual({
      asOf: NOW,
      cap: 500,
      currency: "USD",
      remaining: 320,
      resetsAt: RESET,
      share: 0.64,
      spent: 180,
      startsAt: START,
    });
    const [request, next] = fetch.mock.calls;
    const url = new URL(String(request?.[0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.openai.com/v1/organization/costs"
    );
    expect(url.searchParams.get("start_time")).toBe(
      String(START.getTime() / 1000)
    );
    expect(url.searchParams.get("end_time")).toBe(
      String(Math.floor(NOW.getTime() / 1000))
    );
    expect(url.searchParams.get("project_ids[]")).toBe("proj_work");
    expect(new Headers(request?.[1]?.headers).get("Authorization")).toBe(
      "Bearer test-admin"
    );
    expect(new URL(String(next?.[0])).searchParams.get("page")).toBe("cursor");
  });

  it("reads discounted Anthropic workspace charges in fractional cents and distinguishes zero from unavailable data", async () => {
    vi.setSystemTime(NOW);
    const refreshedAt = "2026-12-19T10:00:00Z";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(anthropicCosts("41280.123456", refreshedAt))
      .mockResolvedValueOnce(anthropicCosts("0.000000", refreshedAt))
      .mockResolvedValueOnce(anthropicCosts("0", null));
    vi.stubGlobal("fetch", fetch);
    const usage = createUsage();
    const name = usage.add({
      billing: { adminKey: "test-admin", cap: 500, workspaceId: "wrkspc_work" },
      name: "work",
      provider: "anthropic",
    });
    const budget = await usage.budget(name);
    expect(budget?.spent).toBeCloseTo(412.801_234_56, 10);
    expect(budget?.remaining).toBeCloseTo(87.198_765_44, 10);
    expect(budget?.reportedThrough).toEqual(new Date(refreshedAt));
    await expect(usage.budget(name)).resolves.toMatchObject({
      remaining: 500,
      share: 1,
      spent: 0,
    });
    await expect(usage.budget(name)).resolves.toBeUndefined();
    const [request] = fetch.mock.calls;
    const url = new URL(String(request?.[0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.anthropic.com/v1/organizations/analytics/cost"
    );
    expect(url.searchParams.get("starting_at")).toBe(START.toISOString());
    expect(url.searchParams.get("workspace_ids[]")).toBe("wrkspc_work");
    const headers = new Headers(request?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("test-admin");
    expect(headers.get("anthropic-beta")).toBe(
      "analytics-usage-cost-2026-08-24"
    );
  });

  it("never reports partial, malformed, or non-USD costs as spend", async () => {
    vi.setSystemTime(NOW);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(openAICosts(5, "cursor"))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(json({ has_more: false }))
      .mockResolvedValueOnce(openAICosts(5, undefined, "eur"));
    vi.stubGlobal("fetch", fetch);
    const usage = createUsage();
    const name = usage.add({
      billing: { adminKey: "test-admin", cap: 500 },
      name: "work",
      provider: "openai",
    });
    await expect(usage.budget(name)).resolves.toBeUndefined();
    await expect(usage.budget(name)).resolves.toBeUndefined();
    await expect(usage.budget(name)).resolves.toBeUndefined();
  });
});
