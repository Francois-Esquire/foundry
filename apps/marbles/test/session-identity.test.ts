import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Provider } from "@foundry/models";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { providerStoreForState, writeAsHost } from "~/database/open";
import { marblesIdentityKeys } from "~/database/tables";
import type { AgentDefinition, SessionRef } from "~/lib/definitions/types";
import { pluginOf } from "./helpers/plugins";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

function replying() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [
          { id: "t", type: "text-start" },
          { delta: "ok", id: "t", type: "text-delta" },
          { id: "t", type: "text-end" },
          {
            finishReason: { raw: undefined, unified: "stop" },
            type: "finish",
            usage,
          },
        ],
      }),
    }),
  });
}

const cli = pluginOf({
  accountEnv: ["ACCOUNT_HOME", "ACCOUNT_TOKEN"],
  catalog: () => [{ id: "m", kind: "text", modelId: "m" }],
  create: ({ id, models }) => ({
    provider: {
      available: true,
      id,
      languageModel: () => replying(),
      models,
    } satisfies Provider,
  }),
  id: "cli",
  label: "CLI",
  settings: z.object({ binPath: z.string().optional() }),
});

const reviewer: AgentDefinition = {
  id: "reviewer",
  kind: "agent",
  model: "m",
  prompt: "Review.",
  provider: "work",
};

const DIGEST = /^[0-9a-f]{32}$/;

let state: string;
let workspaceDir: string;

async function write(
  scope: "machine" | "workspace",
  providers: object[],
  extra: object = {}
): Promise<void> {
  const configuration = { providers, version: 1, ...extra } as never;
  await providerStoreForState(state).update("ws1", () =>
    scope === "machine"
      ? { machine: configuration }
      : { workspace: configuration }
  );
}

async function engine(environment: Record<string, string> = {}) {
  const built = build(environment);
  await built.providers?.refresh();
  return built;
}

function build(environment: Record<string, string>) {
  return createEngine({
    catalog: new Catalog(),
    environment: { ACCOUNT_HOME: "/accounts/personal", ...environment },
    plugins: [cli],
    print: () => undefined,
    root: process.cwd(),
    stateDir: workspaceDir,
    stateRoot: state,
    workspaceId: "ws1",
  });
}

async function opened(e: ReturnType<typeof build>): Promise<SessionRef> {
  const session = await e.agents.session(reviewer);
  await session.generate("Look.");
  return session.ref;
}

beforeEach(async () => {
  state = mkdtempSync(join(tmpdir(), "marbles-identity-"));
  workspaceDir = join(state, "ws1");
  mkdirSync(workspaceDir);
  await writeAsHost(state, (database) =>
    database.insert(marblesIdentityKeys).values({ id: 1, key: "a".repeat(64) })
  );
});

afterEach(() => {
  rmSync(state, { force: true, recursive: true });
});

it("never resumes a session on the other scope's instance with the same id and plugin", async () => {
  await write("machine", [{ enabled: false, id: "work", plugin: "cli" }]);
  await write("workspace", [{ enabled: true, id: "work", plugin: "cli" }]);
  const e = await engine();
  try {
    const ref = await opened(e);
    expect(ref.instance).toMatch(DIGEST);

    await write("machine", [{ enabled: true, id: "work", plugin: "cli" }]);
    await write("workspace", [{ enabled: false, id: "work", plugin: "cli" }]);
    await e.providers?.refresh();
    await expect(
      e.agents.session(reviewer, { session: ref })
    ).rejects.toMatchObject({ code: "SESSION_ROUTE_CONFLICT" });

    await write("workspace", []);
    await e.providers?.refresh();
    await expect(
      e.agents.session(reviewer, { session: ref })
    ).rejects.toMatchObject({ code: "SESSION_ROUTE_CONFLICT" });

    await write("machine", [{ enabled: false, id: "work", plugin: "cli" }]);
    await write("workspace", [{ enabled: true, id: "work", plugin: "cli" }]);
    await e.providers?.refresh();
    const resumed = await e.agents.session(reviewer, { session: ref });
    expect(resumed.ref.instance).toBe(ref.instance);
  } finally {
    await e.dispose();
  }
});

it("keeps a session across edits that leave its account alone, and refuses one that changes it", async () => {
  await write("machine", [
    { enabled: true, id: "other", plugin: "cli" },
    { enabled: true, id: "work", plugin: "cli" },
  ]);
  let e = await engine();
  const ref = await opened(e);
  await write("machine", [
    { defaults: { text: "m" }, enabled: true, id: "work", plugin: "cli" },
    { enabled: true, id: "other", plugin: "cli" },
  ]);
  await e.providers?.refresh();
  await e.providers?.disable("work");
  await e.providers?.enable("work");
  const kept = await e.agents.session(reviewer, { session: ref });
  expect(kept.ref.instance).toBe(ref.instance);

  await e.providers?.update("work", { settings: { binPath: "/opt/cli" } });
  await expect(
    e.agents.session(reviewer, { session: ref })
  ).rejects.toMatchObject({ code: "SESSION_ROUTE_CONFLICT" });
  await e.dispose();
  const accounts: Record<string, string>[] = [
    { ACCOUNT_HOME: "/accounts/other" },
    { ACCOUNT_TOKEN: "set" },
  ];
  await write("machine", [
    { enabled: true, id: "other", plugin: "cli" },
    { enabled: true, id: "work", plugin: "cli" },
  ]);
  e = await engine();
  try {
    const resumed = await e.agents.session(reviewer, { session: ref });
    expect(resumed.ref.instance).toBe(ref.instance);
  } finally {
    await e.dispose();
  }
  for (const account of accounts) {
    e = await engine(account);
    try {
      await expect(
        e.agents.session(reviewer, { session: ref })
      ).rejects.toMatchObject({ code: "SESSION_ROUTE_CONFLICT" });
    } finally {
      await e.dispose();
    }
  }
});

it("starts afresh a ref whose session never ran, even if its instance changed", async () => {
  await write("machine", [{ enabled: true, id: "work", plugin: "cli" }]);
  const e = await engine({ ACCOUNT_HOME: "/accounts/other" });
  try {
    const unrun = await e.agents.session(reviewer, {
      session: {
        id: "filed-not-run",
        instance: "0".repeat(32),
        model: "m",
        provider: "work",
      },
    });
    expect(unrun.ref.id).toBe("filed-not-run");
    expect(unrun.ref.instance).not.toBe("0".repeat(32));
  } finally {
    await e.dispose();
  }
});

it("refuses a ref that ran before instances were identified, and starts one that never ran", async () => {
  await write("machine", [{ enabled: true, id: "work", plugin: "cli" }]);
  const e = await engine();
  try {
    const ref = await opened(e);
    const { instance: _, ...legacy } = ref;
    await expect(
      e.agents.session(reviewer, { session: legacy })
    ).rejects.toMatchObject({ code: "SESSION_ROUTE_UNRECOVERABLE" });
    const fresh = await e.agents.session(reviewer, {
      session: { id: "never-ran", model: "m", provider: "work" },
    });
    expect(fresh.ref.instance).toBe(ref.instance);
  } finally {
    await e.dispose();
  }
});
