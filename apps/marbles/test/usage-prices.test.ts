import type { SessionMessage } from "@foundry/agents/session";
import type { Provider, ProviderModelDefinition } from "@foundry/models";
import { ModelManager } from "@foundry/models";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
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
  const { catalogPrices, loadModelsDev, usageFact } = await pricing();
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

  await loadModelsDev();
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
  const { catalogPrices, loadModelsDev } = await pricing();
  await loadModelsDev();
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
  const { catalogPrices, loadModelsDev } = await pricing();
  await expect(loadModelsDev()).resolves.toBeUndefined();
  expect(catalogPrices(manager(ROW))("codex", "gpt-5-mini")).toBeUndefined();
});

/** A Claude Code-shaped model: each call reports what the CLI says it cost. */
function claudeCode(costs: readonly number[]): ModelManager {
  let call = 0;
  const provider: Provider = {
    available: true,
    id: "claude-code",
    languageModel: () =>
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
    models: [
      {
        capabilities: { functionCalling: true },
        id: "sonnet",
        kind: "text",
        modelId: "sonnet",
        vendor: "anthropic",
      },
    ],
    offline: false,
  };
  return new ModelManager({ providers: [provider] });
}

it("records the cost Claude Code reports for a session's first call, and none for a call that resumed it", async () => {
  vi.stubEnv("FOUNDRY_MODELS_DEV_URL", "");
  vi.resetModules();
  const { catalog } = await import("~/authoring/catalog");
  const { agent } = await import("~/authoring/resources");
  const { step } = await import("~/authoring/builder");
  const { startEngine } = await import("./helpers/engine");
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  step("review").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    await session.generate("first");
    // The CLI's figure here would include the first call's spend.
    await session.generate("second");
    return "done";
  });
  const engine = await startEngine({
    models: claudeCode([0.12, 0.3]),
    print: () => undefined,
  });
  try {
    await (await engine.launch("review", {})).result;
    const costs = engine.usage
      .read()
      .facts.toSorted((a, b) => a.completedAt - b.completedAt)
      .map((fact) => fact.cost);
    expect(costs).toEqual([
      {
        amount: 0.12,
        currency: "USD",
        kind: "reported",
        reference: "claude-code total_cost_usd, the CLI's own estimate",
      },
      { kind: "unknown", reason: "no list price for claude-code/sonnet" },
    ]);
  } finally {
    await engine.dispose();
    catalog.reset();
  }
});
