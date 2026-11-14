import type { SessionMessage } from "@foundry/agents/session";
import type { Provider, ProviderModelDefinition } from "@foundry/models";
import { ModelManager } from "@foundry/models";
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
  await expect(holdModelsDev().loaded).resolves.toBeUndefined();
  expect(catalogPrices(manager(ROW))("codex", "gpt-5-mini")).toBeUndefined();
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
