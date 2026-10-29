import { chmod } from "node:fs/promises";
import { join } from "node:path";

import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { listPrices } from "../consumption";
import { type ClaudeQuery, claudeReading } from "../providers/anthropic/limits";
import { createAnthropic } from "../providers/anthropic/provider";
import { createUsage } from "../usage";
/** A live Max response (SDK 0.3.205, CLI 2.1.310), email and organization scrubbed. */
import LIVE from "./fixtures/claude-usage.json";
import { tempHome, touch, writeJsonl } from "./helpers/machine";

const HOUR = 3_600_000;
const HANG = Symbol("hang");

const answer = (value: unknown): Promise<unknown> => {
  if (value === HANG) {
    return new Promise(() => undefined);
  }
  return value instanceof Error
    ? Promise.reject(value)
    : Promise.resolve(value);
};

/** A stand-in for the SDK's `query`, recording how a read drove it. */
const fakeQuery = (script: { init?: unknown; usage?: unknown } = {}) => {
  const calls = {
    closed: 0,
    options: undefined as Options | undefined,
    usage: 0,
  };
  let prompt: AsyncIterable<SDKUserMessage> | undefined;
  const query: ClaudeQuery = (params) => {
    calls.options = params.options;
    ({ prompt } = params);
    return {
      close: () => {
        calls.closed += 1;
      },
      initializationResult: () =>
        answer(script.init ?? { account: LIVE.account }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
        calls.usage += 1;
        return answer(script.usage ?? LIVE.usage);
      },
    } as unknown as ReturnType<ClaudeQuery>;
  };
  return { calls, prompt: () => prompt, query };
};

const withLimits = (patch: Record<string, unknown>) =>
  claudeReading(LIVE.account, {
    ...LIVE.usage,
    rate_limits: { ...LIVE.usage.rate_limits, ...patch },
  });

describe("Claude limits", () => {
  it("maps the live Max response: hourly, weekly, the Fable weekly, extra usage off", () => {
    expect(claudeReading(LIVE.account, LIVE.usage)).toEqual({
      details: {
        anthropic: {
          extraUsage: { disabledReason: "out_of_credits", enabled: false },
        },
      },
      identity: {
        email: "user@example.com",
        id: "user@example.com",
        plan: "max",
      },
      limits: [
        {
          duration: 5 * HOUR,
          kind: "window",
          resetsAt: new Date("2026-10-26T22:00:00.193Z"),
          span: "hourly",
          usedPercent: 6,
        },
        {
          duration: 168 * HOUR,
          kind: "window",
          resetsAt: new Date("2026-10-29T08:00:00.193Z"),
          span: "weekly",
          usedPercent: 46,
        },
        {
          duration: 168 * HOUR,
          kind: "window",
          model: "Fable",
          resetsAt: new Date("2026-10-29T08:00:00.193Z"),
          span: "weekly",
          usedPercent: 45,
        },
      ],
    });
  });

  it("adds a spend cap only while extra usage is on, in dollars", () => {
    const money = (amount_minor: number, currency = "USD") => ({
      amount_minor,
      currency,
      exponent: 2,
    });
    const capOf = (patch: Record<string, unknown>) =>
      withLimits(patch).limits.find((limit) => limit.kind === "spend-cap");
    expect(
      capOf({
        spend: { enabled: true, limit: money(40_000), used: money(1250) },
      })
    ).toEqual({
      cap: { amount: 400, unit: "usd" },
      kind: "spend-cap",
      used: { amount: 12.5, unit: "usd" },
    });
    expect(
      capOf({
        extra_usage: {
          currency: "USD",
          decimal_places: 2,
          is_enabled: true,
          monthly_limit: 5000,
          used_credits: 500,
        },
      })
    ).toMatchObject({ cap: { amount: 50 }, used: { amount: 5 } });
    expect(
      capOf({
        spend: {
          enabled: true,
          limit: money(400, "EUR"),
          used: money(1, "EUR"),
        },
      })
    ).toBeUndefined();
    expect(capOf({})).toBeUndefined();
  });

  it("clamps percentages and skips model-scoped entries without a reading", () => {
    const { limits } = withLimits({
      five_hour: { resets_at: 1_793_052_000, utilization: 140 },
      model_scoped: [
        { display_name: "Opus 4.5!", utilization: 12 },
        { display_name: "Sonnet", utilization: null },
        "junk",
      ],
      seven_day: { utilization: -5 },
    });
    expect(
      limits.map(
        (limit) =>
          limit.kind === "window" && [
            limit.span,
            limit.model,
            limit.usedPercent,
          ]
      )
    ).toEqual([
      ["hourly", undefined, 100],
      ["weekly", undefined, 0],
      ["weekly", "Opus 4.5!", 12],
    ]);
  });

  it("reads a login without plan limits as unsupported, and one reporting none as a failure", () => {
    expect(
      claudeReading({}, { rate_limits: null, rate_limits_available: false })
    ).toEqual({
      limits: [],
      unsupported: "This Claude login reports no plan limits.",
    });
    expect(() =>
      withLimits({ five_hour: null, model_scoped: [], seven_day: null })
    ).toThrow("no limits");
    expect(() => claudeReading(LIVE.account, {})).toThrow("no limits");
  });
});

describe("Claude reads through a credential", () => {
  const setup = async (
    script: Parameters<typeof fakeQuery>[0] = {},
    env: Record<string, string> = {}
  ) => {
    const home = await tempHome();
    const fake = fakeQuery(script);
    const provider = createAnthropic({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-secret",
        CLAUDE_CODE_OAUTH_TOKEN: "token",
        HOME: home,
        PATH: "",
        ...env,
      },
      home,
      initTimeoutMs: 50,
      query: fake.query,
      usageTimeoutMs: 50,
    });
    return { ...fake, home, provider };
  };

  it("runs a quiet, prompt-free query as the default login, then closes it", async () => {
    const { calls, home, prompt, provider } = await setup(
      {},
      { CLAUDE_CONFIG_DIR: "/elsewhere" }
    );
    const reading = await provider({ configDir: "~/.claude" }).limits();

    expect(reading.limits).toHaveLength(3);
    expect(calls.options).toMatchObject({
      allowedTools: [],
      cwd: home,
      mcpServers: {},
      permissionMode: "dontAsk",
      persistSession: false,
      settingSources: [],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      tools: [],
    });
    // The default login is reached with no CLAUDE_CONFIG_DIR, and no key or token leaks in.
    expect(calls.options?.env).toEqual({
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      HOME: home,
      PATH: "",
    });
    expect(calls.options?.abortController?.signal.aborted).toBe(true);
    expect(calls.closed).toBe(1);
    expect(await prompt()?.[Symbol.asyncIterator]().next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  it("routes another login to its own config dir", async () => {
    const { calls, home, provider } = await setup();
    const work = provider({ configDir: "~/.claude-work", name: "work" });
    await work.limits();

    expect(work.name).toBe("work");
    expect(work.credential).toEqual({
      configDir: join(home, ".claude-work"),
      kind: "login",
    });
    expect(calls.options?.env?.CLAUDE_CONFIG_DIR).toBe(
      join(home, ".claude-work")
    );
  });

  it("reads an API key as unsupported with no history, and never shows the key", async () => {
    const { calls, provider } = await setup();
    const usage = createUsage();
    usage.add(provider({ apiKey: "sk-ant-secret", name: "api" }));
    const snapshot = await usage.query("api");

    expect(snapshot).toMatchObject({
      limits: [],
      unsupported: "An Anthropic API key has no limits to read.",
    });
    expect(snapshot).not.toHaveProperty("failed");
    expect(snapshot.consumption).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(() => provider({ apiKey: undefined, name: "api" })).toThrow("unset");
    expect(calls.options).toBeUndefined();
  });

  it("reads a login that uses an API key as unsupported without asking for usage", async () => {
    const { calls, provider } = await setup({
      init: {
        account: {
          apiKeySource: "ANTHROPIC_API_KEY",
          apiProvider: "firstParty",
        },
      },
    });
    expect((await provider().limits()).unsupported).toContain("API key");
    expect(calls.usage).toBe(0);
  });

  it("fails a signed-out login, and a CLI that hangs, closing it each time", async () => {
    const signedOut = await setup({
      init: { account: { tokenSource: "none" } },
    });
    await expect(signedOut.provider().limits()).rejects.toThrow(
      "not signed in"
    );
    expect(signedOut.calls.closed).toBe(1);

    const hung = await setup({ usage: HANG });
    await expect(hung.provider().limits()).rejects.toThrow("within 50 ms");
    expect(hung.calls.closed).toBe(1);
    expect(hung.calls.options?.abortController?.signal.aborted).toBe(true);
  });

  it("finds the default login by presence only, never the environment's key", async () => {
    const { home, provider } = await setup();
    expect(await provider.defaultAccount()).toBeUndefined();

    await touch(join(home, ".claude.json"));
    const found = await provider.defaultAccount();
    expect(found?.name).toBe("anthropic");
    expect(found?.credential).toEqual({
      configDir: join(home, ".claude"),
      kind: "login",
    });

    const custom = createAnthropic({
      env: { CLAUDE_CONFIG_DIR: join(home, "other") },
      home,
    });
    expect(await custom.defaultAccount()).toBeUndefined();
    await touch(join(home, "other", ".credentials.json"));
    expect((await custom.defaultAccount())?.credential).toEqual({
      configDir: join(home, "other"),
      kind: "login",
    });
  });
});

describe("Claude history", () => {
  const SINCE = new Date("2026-10-28T00:00:00Z");
  const usage = {
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 2000,
    input_tokens: 10,
    output_tokens: 50,
    output_tokens_details: { thinking_tokens: 20 },
  };
  const assistant = (
    id: string,
    model: string,
    timestamp = "2026-10-28T12:00:00Z",
    extra: Record<string, unknown> = {}
  ) => ({
    message: { id: `msg_${id}`, model, usage: { ...usage, ...extra } },
    requestId: `req_${id}`,
    sessionId: "s1",
    timestamp,
    type: "assistant",
  });

  const readHistory = async () => {
    const home = await tempHome();
    const projects = join(home, ".claude", "projects", "-repo");
    const one = assistant("1", "claude-sonnet-4-5");
    await writeJsonl(join(projects, "s1.jsonl"), [
      { message: { content: "hi" }, type: "user" },
      one,
      one, // the same response, once per content block
      assistant("2", "claude-sonnet-4-5", "2026-10-27T23:00:00Z"), // before the span
      assistant("3", "<synthetic>"),
      assistant("4", "claude-mystery-9"),
      assistant("5", "claude-sonnet-4-5", "2026-10-28T13:00:00Z", {
        speed: "fast",
      }),
    ]);
    // A resumed session's copy of an earlier response, and a subagent's own work.
    await writeJsonl(join(projects, "s2.jsonl"), [
      one,
      { ...assistant("6", "claude-sonnet-4-5"), sessionId: "s2" },
    ]);
    await writeJsonl(join(projects, "s1", "subagents", "agent-a.jsonl"), [
      { ...assistant("7", "claude-sonnet-4-5"), sessionId: "s1" },
    ]);
    await writeJsonl(
      join(projects, "old.jsonl"),
      [assistant("8", "claude-sonnet-4-5")],
      new Date("2026-10-01T00:00:00Z")
    );
    const provider = createAnthropic({ env: {}, home });
    return { consumption: await provider().history(SINCE) };
  };

  it("counts each response once, in the span, per session and model, with disjoint tokens", async () => {
    const { consumption } = await readHistory();
    const one = {
      cachedInputTokens: 2000,
      cacheWriteTokens: 300,
      inputTokens: 10,
      outputTokens: 50,
      reasoningTokens: 20,
    };

    expect(consumption?.since).toEqual(SINCE);
    expect(
      consumption?.bySession.map(({ model, quantities, session }) => [
        session,
        model,
        quantities,
      ])
    ).toEqual([
      [
        "s1",
        "claude-sonnet-4-5",
        {
          cachedInputTokens: 6000,
          cacheWriteTokens: 900,
          inputTokens: 30,
          outputTokens: 150,
          reasoningTokens: 60,
        },
      ],
      ["s1", "claude-mystery-9", one],
      ["s2", "claude-sonnet-4-5", one],
    ]);
    expect(consumption?.total).toEqual({
      cachedInputTokens: 10_000,
      cacheWriteTokens: 1500,
      inputTokens: 50,
      outputTokens: 250,
      reasoningTokens: 100,
    });
  });

  it("prices standard work at list price as notional; fast or unlisted work has no charge", async () => {
    const { consumption } = await readHistory();
    const listed = listPrices("anthropic")("claude-sonnet-4-5", {
      cachedInputTokens: 1e6,
      cacheWriteTokens: 1e6,
      inputTokens: 1e6,
      outputTokens: 1e6,
      reasoningTokens: 1e6,
    });
    expect(listed).toEqual({
      amount: { amount: expect.closeTo(22.05, 9), unit: "usd" },
      basis: "priced",
    });

    const [s1, mystery, s2] = consumption?.bySession ?? [];
    expect(s1?.charge).toBeUndefined(); // one of its responses ran fast
    expect(mystery?.charge).toBeUndefined();
    expect(s2?.charge).toEqual({
      amount: { amount: expect.closeTo(0.002_505, 9), unit: "usd" },
      basis: "notional",
    });
    expect(consumption?.charge).toBeUndefined();
  });

  it("reads a login with no history yet as no work", async () => {
    const home = await tempHome();
    const provider = createAnthropic({ env: {}, home });

    const consumption = await provider().history(SINCE);
    expect(consumption?.bySession).toEqual([]);
  });

  it("fails a history it cannot read in full, rather than undercounting", async () => {
    const home = await tempHome();
    const projects = join(home, ".claude", "projects");
    await writeJsonl(join(projects, "-repo", "s1.jsonl"), [
      assistant("1", "claude-sonnet-4-5"),
    ]);
    const locked = join(projects, "-locked");
    await writeJsonl(join(locked, "s2.jsonl"), [
      assistant("2", "claude-sonnet-4-5"),
    ]);
    const provider = createAnthropic({ env: {}, home });

    await chmod(locked, 0o000);
    try {
      await expect(provider().history(SINCE)).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("fails a history root that is not a directory", async () => {
    const home = await tempHome();
    await touch(join(home, ".claude", "projects"));
    const provider = createAnthropic({ env: {}, home });

    await expect(provider().history(SINCE)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});
