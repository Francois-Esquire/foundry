import type { SessionMessage } from "@foundry/agents/session";
import type { Provider, ProviderModelDefinition } from "@foundry/models";
import { ModelManager } from "@foundry/models";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** A trimmed models.dev payload: gpt-5-mini's facts, and OpenAI's own price for it. */
const PAYLOAD = {
  models: { "openai/gpt-5-mini": { name: "GPT-5 mini" } },
  providers: {
    openai: { models: { "gpt-5-mini": { cost: { input: 0.25, output: 2 } } } },
  },
};

const ROW: ProviderModelDefinition = {
  id: "gpt-5-mini",
  kind: "text",
  modelId: "gpt-5-mini",
  vendor: "openai",
};

function manager(row: ProviderModelDefinition): ModelManager {
  const provider: Provider = {
    available: true,
    id: "codex",
    languageModel: () => {
      throw new Error("no turn runs here");
    },
    models: [row],
    offline: false,
  };
  return new ModelManager({ providers: [provider] });
}

const message: SessionMessage = {
  createdAt: 0,
  id: "m1",
  metadata: {
    model: { id: "gpt-5-mini", provider: "codex" },
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    },
  },
  parts: [],
  role: "assistant",
  sessionId: "s1",
  status: "complete",
  updatedAt: 0,
};

/** The ledger's pricing over a fresh models.dev module, so nothing is loaded yet. */
async function pricing() {
  vi.resetModules();
  const source = await import("@foundry/models/catalog/models-dev-source");
  const usage = await import("~/lib/usage");
  return { ...source, ...usage };
}

beforeEach(() => {
  vi.stubEnv("FOUNDRY_MODELS_DEV_URL", "http://models-dev.test/catalog.json");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(PAYLOAD))
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("estimates a turn the catalog has no price for at the models.dev rate, once it has loaded", async () => {
  const { catalogPrices, holdModelsDev, usageFact } = await pricing();
  const price = catalogPrices(manager(ROW));
  const record = () =>
    usageFact(
      {
        message,
        route: { model: "gpt-5-mini", provider: "codex" },
        source: { agentId: "a" },
        workspaceId: "w",
      },
      price
    ).cost;

  expect(record()).toEqual({
    kind: "unknown",
    reason: "no list price for codex/gpt-5-mini",
  });

  await holdModelsDev().loaded;
  expect(record()).toEqual({
    amount: 2.25,
    currency: "USD",
    kind: "estimated",
    pricing: {
      rates: { input: 0.25, output: 2 },
      reference: "models.dev codex/gpt-5-mini",
    },
  });
});

it("keeps the catalog's own price over models.dev's", async () => {
  const { catalogPrices, holdModelsDev } = await pricing();
  await holdModelsDev().loaded;
  const basis = catalogPrices(
    manager({ ...ROW, costs: { input: 1, output: 1 } })
  )("codex", "gpt-5-mini");
  expect(basis).toEqual({
    rates: { input: 1, output: 1 },
    reference: "@foundry/models codex/gpt-5-mini",
  });
});

it("prices nothing when models.dev cannot be read, and throws nothing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline")))
  );
  const { catalogPrices, holdModelsDev } = await pricing();
  const hold = holdModelsDev();
  await expect(hold.loaded).resolves.toBeUndefined();
  expect(catalogPrices(manager(ROW))("codex", "gpt-5-mini")).toBeUndefined();
  hold.release();
});

/** A fetch that answers only when its signal aborts, as a hung server would. */
function hangingFetch() {
  const fetch = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      })
  );
  vi.stubGlobal("fetch", fetch);
  const signal = (call: number) => fetch.mock.calls[call]?.[1]?.signal;
  return { fetch, signal };
}

it("an engine holds the models.dev load while it runs, and disposing it aborts a fetch still waiting", async () => {
  const { fetch, signal } = hangingFetch();
  vi.resetModules();
  const { testEngine } = await import("./helpers/engine");
  const engine = testEngine();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(signal(0)?.aborted).toBe(false);
  await engine.dispose();
  expect(signal(0)?.aborted).toBe(true);
});

it("Airplane Mode gives up the load, and leaving it starts the load again", async () => {
  const { fetch, signal } = hangingFetch();
  vi.resetModules();
  const { testEngine } = await import("./helpers/engine");
  const engine = testEngine();
  try {
    engine.airplane.set(true);
    expect(engine.airplane.enabled).toBe(true);
    expect(signal(0)?.aborted).toBe(true);
    engine.airplane.set(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signal(1)?.aborted).toBe(false);
  } finally {
    await engine.dispose();
  }
  expect(signal(1)?.aborted).toBe(true);
});

it("an engine that started offline is priced after Airplane Mode is turned on and off", async () => {
  const fetch = vi
    .fn(async () => Response.json(PAYLOAD))
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetch);
  vi.resetModules();
  const { testEngine } = await import("./helpers/engine");
  const { loadedModelsDev } = await import(
    "@foundry/models/catalog/models-dev-source"
  );
  const engine = testEngine();
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(loadedModelsDev()).toBeUndefined();
    engine.airplane.set(true);
    engine.airplane.set(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(loadedModelsDev()).toBeDefined());
  } finally {
    await engine.dispose();
  }
});

/**
 * The real Claude Code provider over a vendor model that reports what the
 * CLI says each call cost, with the settings the vendor would merge.
 */
async function claudeCode(
  costs: readonly number[],
  defaultSettings: ClaudeCodeSettings = {}
): Promise<ModelManager> {
  let call = 0;
  vi.doMock("ai-sdk-provider-claude-code", async (original) => ({
    ...(await original<object>()),
    createClaudeCode: () => ({
      languageModel: (_id: string, settings: ClaudeCodeSettings) =>
        Object.assign(
          new MockLanguageModelV4({
            doStream: () => {
              const costUsd = costs[call] ?? 0;
              call += 1;
              return Promise.resolve({
                stream: simulateReadableStream({
                  chunks: [
                    { id: "t", type: "text-start" },
                    { delta: "ok", id: "t", type: "text-delta" },
                    { id: "t", type: "text-end" },
                    {
                      finishReason: { raw: undefined, unified: "stop" },
                      providerMetadata: { "claude-code": { costUsd } },
                      type: "finish",
                      usage: {
                        inputTokens: {
                          cacheRead: 0,
                          cacheWrite: 0,
                          noCache: 10,
                          total: 10,
                        },
                        outputTokens: { reasoning: 0, text: 2, total: 2 },
                      },
                    },
                  ],
                }),
              });
            },
          }),
          { settings: { ...defaultSettings, ...settings } }
        ),
    }),
  }));
  const { claudeCodeProvider } = await import("@foundry/models/claude-code");
  return new ModelManager({
    providers: [
      claudeCodeProvider({
        config: { available: true },
        env: {},
        models: [
          {
            capabilities: { functionCalling: true },
            id: "sonnet",
            kind: "text",
            modelId: "sonnet",
            vendor: "anthropic",
          },
        ],
      }),
    ],
  });
}

/** The saved costs of a run whose step opens one session and takes two turns. */
async function twoTurns(models: () => Promise<ModelManager>) {
  vi.stubEnv("FOUNDRY_MODELS_DEV_URL", "");
  vi.resetModules();
  const built = await models();
  const { catalog } = await import("~/authoring/catalog");
  const { agent } = await import("~/authoring/resources");
  const { step } = await import("~/authoring/builder");
  const { startEngine } = await import("./helpers/engine");
  const { totalOf } = await import("~/workspace/usage");
  const { costCell } = await import("~/views/usage-format");
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  step("review").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    await session.generate("first");
    // This call resumes the first one's CLI session.
    await session.generate("second");
    return "done";
  });
  const engine = await startEngine({ models: built, print: () => undefined });
  try {
    await (await engine.launch("review", {})).result;
    const facts = engine.usage
      .read()
      .facts.toSorted((a, b) => a.completedAt - b.completedAt);
    return {
      cell: costCell(totalOf(facts)),
      costs: facts.map((fact) => fact.cost),
    };
  } finally {
    await engine.dispose();
    catalog.reset();
    vi.doUnmock("ai-sdk-provider-claude-code");
  }
}

it("records Claude Code's own estimate for a turn that resumed no session, and none for a turn that resumed one", async () => {
  const { cell, costs } = await twoTurns(() => claudeCode([0.12, 0.3]));
  expect(costs).toEqual([
    {
      amount: 0.12,
      currency: "USD",
      estimate: true,
      kind: "reported",
      reference: "claude-code total_cost_usd",
    },
    { kind: "unknown", reason: "no list price for claude-code/sonnet" },
  ]);
  // The CLI's figure is an estimate, and shows as one.
  expect(cell).toBe("~$0.1200+?");
});

it("records no Claude Code cost when the settings resume a session", async () => {
  const { costs } = await twoTurns(() =>
    claudeCode([0.12, 0.3], { resume: "earlier" })
  );
  expect(costs).toEqual([
    { kind: "unknown", reason: "no list price for claude-code/sonnet" },
    { kind: "unknown", reason: "no list price for claude-code/sonnet" },
  ]);
});

it("a meter gives a turn the marked figure only when the turn made exactly one call", async () => {
  const { costMeter } = await pricing();
  const marked = {
    "claude-code": { costUsd: 0.12 },
    foundry: { claudeCodeFresh: true },
  };
  let call = 0;
  const vendor = new MockLanguageModelV4({
    doGenerate: () => {
      call += 1;
      return Promise.resolve({
        content: [],
        finishReason: { raw: undefined, unified: "stop" },
        // Only the first call resumed no session.
        providerMetadata:
          call === 1 ? marked : { "claude-code": { costUsd: 0.3 } },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      });
    },
  });
  const options = { prompt: [] };

  const meter = costMeter();
  const model = meter.wrap(vendor);
  await model.doGenerate(options);
  await model.doGenerate(options);
  // Two calls in one turn: the marked figure is not the turn's own.
  expect(meter.take()).toBeUndefined();

  call = 0;
  const single = costMeter();
  const alone = single.wrap(vendor);
  await alone.doGenerate(options);
  expect(single.take()).toEqual({
    amount: 0.12,
    estimate: true,
    reference: "claude-code total_cost_usd",
  });
  await alone.doGenerate(options);
  expect(single.take()).toBeUndefined();
});
