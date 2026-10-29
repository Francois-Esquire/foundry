import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { codexReading } from "../providers/openai/limits";
import { createOpenAI } from "../providers/openai/provider";
import { FakeCodex, tempHome, touch, writeJsonl } from "./helpers/machine";

const MINUTE = 60_000;

/** `account/read` on a signed-in Pro account, as the CLI answered it live. */
const PRO_ACCOUNT = {
  account: { email: "user@example.com", planType: "pro", type: "chatgpt" },
  requiresOpenaiAuth: true,
  workspaceRouting: { chatgptAccountId: "workspace-1" },
};

const PRO_SNAPSHOT = {
  credits: { balance: "57812.7825625000", hasCredits: true, unlimited: false },
  individualLimit: null,
  limitId: "codex",
  planType: "pro",
  primary: {
    resetsAt: 1_793_634_156,
    usedPercent: 25,
    windowDurationMins: 10_080,
  },
  rateLimitReachedType: null,
  secondary: null,
};

/** `account/rateLimits/read` on the same account: the primary window is the weekly one. */
const PRO_RATE_LIMITS = {
  accountId: "workspace-1",
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [
      { expiresAt: 1_793_299_987, status: "available" },
      { expiresAt: 1_794_007_455, status: "available" },
      { expiresAt: 1_700_000_000, status: "redeemed" },
    ],
  },
  rateLimits: PRO_SNAPSHOT,
  rateLimitsByLimitId: { codex: PRO_SNAPSHOT },
};

const windowsOf = (snapshot: Record<string, unknown>) =>
  codexReading(PRO_ACCOUNT, { rateLimits: snapshot }).limits.flatMap((limit) =>
    limit.kind === "window"
      ? [[limit.id, limit.span / MINUTE, limit.usedPercent]]
      : []
  );

describe("Codex limits", () => {
  it("maps the live Pro shape: the primary is weekly by its duration, credits are a credit balance", () => {
    expect(codexReading(PRO_ACCOUNT, PRO_RATE_LIMITS)).toEqual({
      account: { email: "user@example.com", id: "workspace-1", plan: "pro" },
      details: {
        openai: {
          resetCredits: {
            available: 2,
            nextExpiresAt: new Date(1_793_299_987_000),
          },
        },
      },
      limits: [
        {
          id: "weekly-window",
          kind: "window",
          resetsAt: new Date(1_793_634_156_000),
          span: 10_080 * MINUTE,
          usedPercent: 25,
        },
        { kind: "credit-balance", remaining: 57_812.782_562_5 },
      ],
    });
  });

  it("names windows by reported duration, falling back by position only when none is reported", () => {
    expect(
      windowsOf({ primary: { usedPercent: 5 }, secondary: { usedPercent: 6 } })
    ).toEqual([
      ["five-hour-window", 300, 5],
      ["weekly-window", 10_080, 6],
    ]);
    expect(
      windowsOf({ planType: "free", primary: { usedPercent: 5 } })
    ).toEqual([["43200-minute-window", 43_200, 5]]);
    expect(
      windowsOf({ primary: { usedPercent: 140, windowDurationMins: 300 } })
    ).toEqual([["five-hour-window", 300, 100]]);
  });

  it("prefers the codex limit id, ignores another, and names what stopped the account", () => {
    const reading = codexReading(PRO_ACCOUNT, {
      rateLimits: { primary: { usedPercent: 90 } },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 10 },
          rateLimitReachedType: "rate_limit_reached",
        },
      },
    });
    expect(reading.limits).toMatchObject([{ usedPercent: 10 }]);
    expect(reading.details?.openai?.limitReached).toBe("rate_limit_reached");
    expect(() =>
      codexReading(PRO_ACCOUNT, {
        rateLimits: {
          limitId: "gpt-5-codex-mini",
          primary: { usedPercent: 40 },
        },
      })
    ).toThrow("no limits");
    expect(() =>
      codexReading(PRO_ACCOUNT, {
        rateLimits: { primary: null, secondary: null },
      })
    ).toThrow("no limits");
  });
});

describe("Codex reads through a credential", () => {
  const setup = async (results: Record<string, unknown>, timeoutMs = 1000) => {
    const home = await tempHome();
    const child = new FakeCodex(results);
    const spawn = vi.fn(() => child);
    const provider = createOpenAI({
      env: {
        CODEX_API_KEY: "k",
        HOME: home,
        OPENAI_API_KEY: "sk-secret",
        PATH: "/bin",
      },
      home,
      spawn,
      timeoutMs,
    });
    return { child, home, provider, spawn };
  };
  const signedIn = {
    "account/rateLimits/read": PRO_RATE_LIMITS,
    "account/read": PRO_ACCOUNT,
  };

  it("handshakes, reads the account and its limits in the login's home, and kills the server", async () => {
    const { child, home, provider, spawn } = await setup(signedIn);
    const personal = provider.login({ home: "~/.codex-personal" });
    const reading = await provider.limits(personal);

    expect(personal.home).toBe(join(home, ".codex-personal"));
    expect(spawn).toHaveBeenCalledWith("codex", ["app-server"], {
      cwd: home,
      env: {
        CODEX_HOME: join(home, ".codex-personal"),
        HOME: home,
        PATH: "/bin",
      },
    });
    expect(child.methods).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
    ]);
    expect(reading.account?.id).toBe("workspace-1");
    expect(child.killed).toBe(true);
  });

  it("reads a login on an API key as unsupported without asking for limits", async () => {
    const { child, provider } = await setup({
      "account/read": { account: { type: "apiKey" } },
    });
    expect((await provider.limits(provider.login())).unsupported).toContain(
      "API key"
    );
    expect(child.methods).not.toContain("account/rateLimits/read");
    expect(child.killed).toBe(true);
  });

  it("fails a signed-out login, a refused request, and a server that never answers, killing it each time", async () => {
    const signedOut = await setup({ "account/read": { account: null } });
    await expect(
      signedOut.provider.limits(signedOut.provider.login())
    ).rejects.toThrow("not signed in");
    expect(signedOut.child.killed).toBe(true);

    const refused = await setup({
      ...signedIn,
      "account/rateLimits/read": new Error("auth required"),
    });
    await expect(
      refused.provider.limits(refused.provider.login())
    ).rejects.toThrow("refused a request: auth required");

    const silent = await setup({ "account/read": PRO_ACCOUNT }, 50);
    await expect(
      silent.provider.limits(silent.provider.login())
    ).rejects.toThrow("within 50 ms");
    expect(silent.child.killed).toBe(true);
  });

  it("fails when codex is not installed", async () => {
    const { child, provider } = await setup({});
    setTimeout(
      () =>
        child.emit(
          "error",
          Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })
        ),
      1
    );
    await expect(provider.limits(provider.login())).rejects.toThrow(
      "not installed"
    );
  });

  it("reads an API key as unsupported with no history, never spawning or naming the key", async () => {
    const { provider, spawn } = await setup({});
    const key = provider.apiKey("sk-secret");
    expect(key.id).not.toContain("secret");
    expect((await provider.limits(key)).unsupported).toBe(
      "An OpenAI API key has no limits to read."
    );
    expect(await provider.history(key, new Date(0))).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("detects the default login by its auth file, honouring CODEX_HOME, and a key from the environment", async () => {
    const { home, provider } = await setup({});
    expect(
      (await provider.detect()).map((credential) => credential.kind)
    ).toEqual(["api-key"]);
    await touch(join(home, ".codex", "auth.json"));
    expect(await provider.detect()).toEqual([
      provider.login(),
      provider.apiKey("sk-secret"),
    ]);

    const custom = createOpenAI({
      env: { CODEX_HOME: join(home, "alt") },
      home,
    });
    await touch(join(home, "alt", "auth.json"));
    expect(await custom.detect()).toEqual([
      {
        home: join(home, "alt"),
        id: join(home, "alt"),
        kind: "login",
        provider: "openai",
      },
    ]);
  });
});

describe("Codex history", () => {
  const SINCE = new Date("2026-10-28T00:00:00Z");
  const at = (seconds: number) =>
    new Date(SINCE.getTime() + seconds * 1000).toISOString();
  const tokens = (
    input: number,
    cached: number,
    output: number,
    reasoning = 0
  ) => ({
    cached_input_tokens: cached,
    input_tokens: input,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  });
  const meta = (
    id: string,
    seconds: number,
    extra: Record<string, unknown> = {}
  ) => ({
    payload: { id, ...extra },
    timestamp: at(seconds),
    type: "session_meta",
  });
  const context = (model: string, seconds: number) => ({
    payload: { model },
    timestamp: at(seconds),
    type: "turn_context",
  });
  const count = (seconds: number, last: unknown, total: unknown) => ({
    payload: {
      info: { last_token_usage: last, total_token_usage: total },
      type: "token_count",
    },
    timestamp: at(seconds),
    type: "event_msg",
  });
  const tier = (service_tier: string, seconds: number) => ({
    payload: {
      thread_settings: { service_tier },
      type: "thread_settings_applied",
    },
    timestamp: at(seconds),
    type: "event_msg",
  });

  const read = async (files: Record<string, readonly unknown[]>) => {
    const home = await tempHome();
    for (const [path, lines] of Object.entries(files)) {
      await writeJsonl(join(home, ".codex", path), lines);
    }
    const provider = createOpenAI({ env: {}, home });
    return {
      consumption: await provider.history(provider.login(), SINCE),
      provider,
    };
  };
  const rows = (consumption: Awaited<ReturnType<typeof read>>["consumption"]) =>
    consumption?.bySession.map(({ model, quantities, session }) => [
      session,
      model,
      quantities,
    ]);

  it("counts each request from its own usage, once, with cached input taken out of input", async () => {
    const { consumption } = await read({
      "sessions/2026/10/28/rollout-a.jsonl": [
        meta("a", -100),
        context("gpt-5.5", -99),
        count(-90, tokens(1000, 0, 10), tokens(1000, 0, 10)), // before the span: the baseline only
        count(
          10,
          tokens(100_000, 100_000, 10_000, 4000),
          tokens(101_000, 100_000, 10_010, 4000)
        ),
        count(
          11,
          tokens(100_000, 100_000, 10_000, 4000),
          tokens(101_000, 100_000, 10_010, 4000)
        ), // re-emitted
        count(12, tokens(0, 0, 0), tokens(101_000, 100_000, 10_010, 4000)), // a context-size marker
        context("gpt-mystery", 20),
        count(30, tokens(500, 200, 5), tokens(101_500, 100_200, 10_015, 4000)),
      ],
    });
    expect(rows(consumption)).toEqual([
      [
        "a",
        "gpt-5.5",
        {
          cachedInputTokens: 100_000,
          outputTokens: 10_000,
          reasoningTokens: 4000,
        },
      ],
      [
        "a",
        "gpt-mystery",
        { cachedInputTokens: 200, inputTokens: 300, outputTokens: 5 },
      ],
    ]);
  });

  it("skips the history a forked rollout copies from its parent", async () => {
    const { consumption } = await read({
      "sessions/2026/10/28/rollout-child.jsonl": [
        meta("child", 100, { forked_from_id: "parent" }),
        meta("parent", 100),
        context("gpt-5.5", 100),
        count(100.01, tokens(1000, 0, 10), tokens(1000, 0, 10)),
        count(100.03, tokens(2000, 0, 20), tokens(3000, 0, 30)),
        count(110, tokens(400, 0, 4), tokens(3400, 0, 34)),
      ],
    });
    expect(rows(consumption)).toEqual([
      ["child", "gpt-5.5", { inputTokens: 400, outputTokens: 4 }],
    ]);
  });

  it("counts a rollout found in both sessions and archived sessions once", async () => {
    const rollout = [
      meta("moved", 1),
      context("gpt-5.5", 2),
      count(3, tokens(100, 0, 1), tokens(100, 0, 1)),
      count(4, tokens(100, 0, 1), tokens(200, 0, 2)),
    ];
    const { consumption } = await read({
      "archived_sessions/rollout-moved.jsonl": rollout,
      "sessions/2026/10/28/rollout-moved.jsonl": rollout,
    });
    expect(rows(consumption)).toEqual([
      ["moved", "gpt-5.5", { inputTokens: 200, outputTokens: 2 }],
    ]);
  });

  it("prices standard work as notional, and a priority tier or unlisted model not at all", async () => {
    const { consumption, provider } = await read({
      "sessions/2026/10/28/rollout-b.jsonl": [
        meta("b", 1),
        context("gpt-5.5", 2),
        count(
          3,
          tokens(200_000, 100_000, 10_000),
          tokens(200_000, 100_000, 10_000)
        ),
      ],
      "sessions/2026/10/28/rollout-c.jsonl": [
        meta("c", 1),
        tier("priority", 1),
        context("gpt-5.5", 2),
        count(3, tokens(10, 0, 1), tokens(10, 0, 1)),
      ],
    });
    const [standard, priority] = consumption?.bySession ?? [];
    expect(standard?.charge).toEqual({
      amount: { amount: expect.closeTo(0.85, 9), unit: "usd" },
      basis: "notional",
    });
    expect(priority?.charge).toBeUndefined();
    expect(consumption?.charge).toBeUndefined();
    expect(provider.price("gpt-mystery", { inputTokens: 1 })).toBeUndefined();
  });
});
