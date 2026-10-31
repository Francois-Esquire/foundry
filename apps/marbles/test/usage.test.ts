/**
 * Marbles re-exports the shared `usage` and adds its default accounts
 * before any step runs, on a host and in a plain script. The providers are
 * faked: no login is looked for and no client is started. Each test loads
 * Marbles afresh, so each starts from a process that initialized nothing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const accounts = new Set<string>();
  const initialize = vi.fn(async () => {
    // Slower than building an engine, so a step that ran first would miss it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    accounts.add("anthropic");
    accounts.add("openai");
    return [];
  });
  const query = vi.fn((name: string) =>
    accounts.has(name)
      ? Promise.resolve({ at: new Date(0), limits: [], name, provider: name })
      : Promise.reject(new Error(`No usage account named "${name}" is added.`))
  );
  return { accounts, usage: { add: vi.fn(), initialize, query, use: vi.fn() } };
});

vi.mock("@foundry/usage", () => ({ usage: fake.usage }));
// The host loads sources through a Bun plugin; vitest runs under Node, and
// these tests load none.
vi.mock("bun", () => ({ plugin: vi.fn() }));

const UNKNOWN_ACCOUNT = /No usage account/;

let root: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-usage-"));
  fake.accounts.clear();
  fake.usage.initialize.mockClear();
  vi.resetModules();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await rm(root, { force: true, recursive: true });
});

/** Marbles as a fresh process sees it, and a step that queries `usage`. */
async function marbles() {
  const authoring = await import("@foundry.sh/marbles");
  const { catalog } = await import("~/authoring/catalog");
  const runtime = await import("~/authoring/runtime");
  const { hostEngine } = await import("~/workspace/open");
  const { workspaceState } = await import("~/lib/state/workspace");
  const { testEngine } = await import("./helpers/engine");
  cleanups.push(async () => {
    await runtime.dispose();
    catalog.reset();
  });
  // A step returns plain data, and a snapshot holds dates.
  const check = authoring.step().do(async () => {
    const { name, provider } = await authoring.usage.query("anthropic");
    return { name, provider };
  });
  const openHost = async (print: (line: string) => void) => {
    const workspace = workspaceState(join(root, "state"), root);
    const engine = await hostEngine(
      {
        artifacts: join(root, "artifacts"),
        config: root,
        dry: true,
        only: [],
        state: join(root, "state"),
      },
      { config: null, configPath: root, workspace },
      { print }
    );
    cleanups.push(() => engine.dispose());
    return engine;
  };
  return { ...authoring, ...runtime, check, openHost, testEngine };
}

it("exports the shared usage", async () => {
  const { usage } = await marbles();
  expect(usage).toBe(fake.usage);
});

it("has the default accounts before a host's first step", async () => {
  const { check, openHost } = await marbles();
  const engine = await openHost(() => undefined);
  await engine.start();
  await expect(check.run()).resolves.toMatchObject({ name: "anthropic" });
  expect(fake.usage.initialize).toHaveBeenCalledOnce();
});

it("has the default accounts before a plain script's first step", async () => {
  const { check, setDefaultRuntime, testEngine } = await marbles();
  setDefaultRuntime(() =>
    Promise.resolve(testEngine({ print: () => undefined, root }))
  );
  await expect(check.run()).resolves.toMatchObject({
    name: "anthropic",
    provider: "anthropic",
  });
  expect(fake.usage.initialize).toHaveBeenCalledOnce();
});

it("keeps a host running when the accounts cannot be added", async () => {
  fake.usage.initialize.mockRejectedValueOnce(new Error("no login"));
  const { check, openHost } = await marbles();
  const printed: string[] = [];
  const engine = await openHost((line) => printed.push(line));
  expect(printed).toContain(
    "[usage] could not add the default accounts: no login"
  );
  await engine.start();
  await expect(check.run()).rejects.toThrow(UNKNOWN_ACCOUNT);
  // Forgotten, so the next start tries again.
  await openHost(() => undefined);
  expect(fake.usage.initialize).toHaveBeenCalledTimes(2);
  await expect(check.run()).resolves.toMatchObject({ name: "anthropic" });
});
