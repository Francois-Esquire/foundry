import { createMemoryAuthorization } from "@foundry/agents/authorization";
import type { HarnessTurnDriver } from "@foundry/agents/harness";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import type { Container } from "@foundry/sandbox";
import { beforeEach, expect, it, vi } from "vitest";
import { codex as codexPlugin } from "~/lib/providers/codex";
import type { Execution } from "~/lib/providers/plugins";
import { guestAuth } from "~/lib/sandbox/credentials";
import { FIRST_PARTY_DRIVERS } from "~/lib/sandbox/drivers";
import { prepareGuest } from "~/lib/sandbox/prepare";
import { createSandboxSession } from "~/lib/sandbox/session";
import type { SandboxHandle } from "~/lib/types";

const seen = vi.hoisted(() => ({
  auth: [] as unknown[],
  codex: [] as unknown[],
  driven: [] as unknown[],
  routes: [] as unknown[],
}));

vi.mock("@foundry/agents/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@foundry/agents/harness")>()),
  createDriverSession: (settings: { model: unknown }, driver: unknown) => {
    seen.driven.push(driver);
    seen.routes.push(settings.model);
    return { sessionId: "session" };
  },
}));
vi.mock("@foundry/models/providers/codex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@foundry/models/providers/codex")>()),
  createCodexDriver: (options: unknown) => {
    seen.codex.push(options);
    return { first: "party" };
  },
}));
vi.mock("~/lib/sandbox/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/sandbox/credentials")>()),
  guestAuth: (_harness: string, options: unknown) => {
    seen.auth.push(options);
    return { apiKey: "key", kind: "apiKey" };
  },
}));
vi.mock("~/lib/sandbox/prepare", () => ({
  prepareGuest: async () => ({
    environment: { HOME: "/guest" },
    executable: "/opt/foundry/bin/codex",
  }),
}));
vi.mock("~/lib/sandbox/session-state", () => ({
  assertGuestSessionState: async () => undefined,
}));

const container = {
  processes: { spawn: vi.fn() },
  row: { nativeId: "guest-1" },
} as unknown as Container;

function open(execution?: Execution, wireModelId?: string) {
  return createSandboxSession({
    agentId: "coder",
    container,
    drivers: FIRST_PARTY_DRIVERS,
    ...(execution ? { execution } : {}),
    guestAuth,
    harness: "codex",
    hostCwd: process.cwd(),
    instructions: "inspect",
    modelId: wireModelId === undefined ? "gpt-5.5" : "sol",
    options: {
      authority: { authorization: createMemoryAuthorization() },
      sandbox: {} as SandboxHandle,
    },
    prepareGuest,
    provider: "work-codex",
    sessionId: "session",
    signal: new AbortController().signal,
    store: new MemorySessionStore(),
    ...(wireModelId === undefined ? {} : { wireModelId }),
    write: () => undefined,
  });
}

function codex(id: string, env: Record<string, string>): Execution {
  const { execution } = codexPlugin.create({
    env,
    id,
    models: [],
    scope: "machine",
    settings: {},
  });
  if (!execution) {
    throw new Error("Codex instances run in a guest");
  }
  return execution;
}

beforeEach(() => {
  seen.auth.length = 0;
  seen.codex.length = 0;
  seen.driven.length = 0;
  seen.routes.length = 0;
});

it("uses the selected wire ID while keeping the sandbox session route", async () => {
  await open(codex("work-codex", {}), "gpt-6.10-sol");
  expect(seen.auth).toEqual([
    expect.objectContaining({ modelId: "gpt-6.10-sol" }),
  ]);
  expect(seen.codex).toEqual([
    expect.objectContaining({ modelId: "gpt-6.10-sol" }),
  ]);
  expect(seen.routes).toEqual([
    { harness: "codex", id: "sol", provider: "work-codex" },
  ]);
});

it("drives a guest CLI with the provider instance's own driver and environment", async () => {
  const driver = { custom: true } as unknown as HarnessTurnDriver;
  const execution: Execution = {
    ...codex("work-codex", { CODEX_HOME: "/work" }),
    driver: vi.fn(() => driver),
  };
  await open(execution);
  expect(execution.driver).toHaveBeenCalledWith(
    expect.objectContaining({
      auth: { apiKey: "key", kind: "apiKey" },
      guest: {
        environment: { HOME: "/guest" },
        executable: "/opt/foundry/bin/codex",
      },
    })
  );
  expect(seen.driven).toEqual([driver]);
  expect(seen.auth).toEqual([
    expect.objectContaining({ env: { CODEX_HOME: "/work" } }),
  ]);
  expect(seen.codex).toEqual([]);
});

it("gives a first-party instance the first-party driver", async () => {
  await open(codex("codex", {}));
  expect(seen.codex).toEqual([
    expect.objectContaining({
      binPath: "/opt/foundry/bin/codex",
      env: { HOME: "/guest" },
    }),
  ]);
});

it("falls back to the first-party driver, with no instance environment, when no execution is supplied", async () => {
  await open();
  expect(seen.codex).toHaveLength(1);
  expect(seen.driven).toEqual([{ first: "party" }]);
  expect(seen.auth).toEqual([
    expect.not.objectContaining({ env: expect.anything() }),
  ]);
});
