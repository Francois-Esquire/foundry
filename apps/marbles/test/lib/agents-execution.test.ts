import { MemorySessionStore } from "@foundry/agents/store/memory";
import { Models } from "@foundry/models";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentsDeps } from "~/lib/managers/agents";
import { AgentsManager } from "~/lib/managers/agents";
import { codex as codexPlugin } from "~/lib/providers/codex";
import type { Execution } from "~/lib/providers/plugins";
import type { SandboxSessionSettings } from "~/lib/sandbox/session";
import type { AgentDefinition, SandboxHandle } from "~/lib/types";
import { testEngine } from "../helpers/engine";
import { CODEX } from "../helpers/harnesses";
import { mockModels } from "../helpers/mock";

const opened = vi.hoisted(() => [] as SandboxSessionSettings[]);

vi.mock("~/lib/sandbox/session", () => ({
  createSandboxSession: (settings: SandboxSessionSettings) => {
    opened.push(settings);
    return Promise.resolve({
      capabilities: { interruption: false, steering: false },
      route: { id: settings.modelId, provider: settings.provider },
      sessionId: settings.sessionId,
      store: settings.store,
    });
  },
}));

const host = testEngine();
const sandbox = { id: "guest" } as unknown as SandboxHandle;
const coder: AgentDefinition = {
  id: "coder",
  kind: "agent",
  model: CODEX.model,
  prompt: "Fix it.",
  provider: CODEX.provider,
};

function deps(
  executionOf: AgentsDeps["executionOf"],
  models = mockModels([CODEX], () => "ok")
): AgentsDeps {
  return {
    activities: host.activities,
    authorization: host.authorization,
    automations: host.automations,
    containerOf: () => ({}) as ReturnType<AgentsDeps["containerOf"]>,
    defaultExecutor: () => CODEX,
    ...(executionOf ? { executionOf } : {}),
    cwd: process.cwd(),
    interactions: host.interactions,
    models,
    sessions: new MemorySessionStore(),
    skills: () => Promise.resolve([]),
    warn: () => undefined,
  };
}

async function open(d: AgentsDeps, definition = coder) {
  const manager = new AgentsManager(d);
  try {
    await manager.session(definition, { sandbox });
  } finally {
    await manager.close();
  }
  return opened.at(-1);
}

beforeEach(() => {
  opened.length = 0;
});

it("runs a configured provider with no execution on the built-in harness, whatever its id", async () => {
  const settings = await open(deps(() => null));
  expect(settings?.harness).toBe("direct");
  expect(settings?.execution).toBeUndefined();
  expect(settings?.model).toBeDefined();
});

it("runs a configured CLI provider's own execution in the guest", async () => {
  const { execution } = codexPlugin.create({
    env: { CODEX_HOME: "/work" },
    id: "codex",
    models: [],
    scope: "machine",
    settings: {},
  });
  const settings = await open(deps(() => execution));
  expect(settings?.harness).toBe("codex");
  expect(settings?.execution).toBe(execution);
});

it("passes the resolved wire ID to a guest while keeping the model selection", async () => {
  const { execution, provider } = codexPlugin.create({
    env: { CODEX_HOME: "/work" },
    id: "codex",
    models: [{ id: "sol", kind: "text", modelId: "gpt-6.10-sol" }],
    scope: "machine",
    settings: { binPath: "/configured/codex" },
  });
  const settings = await open(
    deps(() => execution, new Models({ providers: [provider] })),
    { ...coder, model: "sol" }
  );
  expect(settings).toMatchObject({
    modelId: "sol",
    wireModelId: "gpt-6.10-sol",
  });
});

it("reads the execution of the instance it resolved, even if the id is rebound before the session opens", async () => {
  const models = mockModels([CODEX], () => "ok");
  const first = { harness: "codex", tag: "first" } as unknown as Execution;
  const second = { harness: "codex", tag: "second" } as unknown as Execution;
  let current = first;
  const d = {
    ...deps(() => current, models),
    skills: () => {
      current = second;
      return Promise.resolve([]);
    },
  };
  const settings = await open(d);
  expect(settings?.execution).toBe(first);
});

it("chooses the CLI by id only for a provider no configuration describes", async () => {
  const settings = await open(deps(undefined));
  expect(settings?.harness).toBe("codex");
  expect(settings?.execution).toBeUndefined();
});
