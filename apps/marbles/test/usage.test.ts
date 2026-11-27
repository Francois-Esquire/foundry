import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const accounts = new Set<string>();
  const initialize = vi.fn(async () => {
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

vi.mock("@foundry/usage/node", () => ({ usage: fake.usage }));

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

async function marbles() {
  const authoring = await import("@foundry.sh/marbles");
  const { Catalog } = await import("~/authoring/catalog");
  const runtime = await import("~/authoring/runtime");
  const { resetUsage } = await import("~/authoring/usage");
  const { initializeUsage } = await import("~/workspace/node-usage");
  const { hostEngine } = await import("~/workspace/open");
  const { workspaceState } = await import("~/lib/state/workspace");
  const { testEngine } = await import("./helpers/engine");
  cleanups.push(async () => {
    await runtime.dispose();
    resetUsage();
  });
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
        directory: root,
        dry: true,
        state: join(root, "state"),
      },
      {
        catalog: new Catalog(),
        config: null,
        configPath: root,
        cwd: workspace.root,
        environment: {},
        files: [],
        workspace,
      },
      { print }
    );
    cleanups.push(() => engine.dispose());
    return engine;
  };
  return {
    ...authoring,
    ...runtime,
    check,
    initializeUsage,
    openHost,
    testEngine,
  };
}

it("starts with a portable usage facade and binds Node usage when hosted", async () => {
  const { openHost, usage } = await marbles();
  await expect(usage.query()).resolves.toEqual([]);
  expect(fake.usage.initialize).not.toHaveBeenCalled();
  await openHost(() => undefined);
  expect(fake.usage.initialize).toHaveBeenCalledOnce();
  await expect(usage.query("anthropic")).resolves.toMatchObject({
    name: "anthropic",
  });
}, 20_000);

it("has the default accounts before a host's first step", async () => {
  const { check, openHost } = await marbles();
  const engine = await openHost(() => undefined);
  await engine.start();
  await expect(check.run()).resolves.toMatchObject({ name: "anthropic" });
  expect(fake.usage.initialize).toHaveBeenCalledOnce();
});

it("has the default accounts before a plain script's first step", async () => {
  const { check, initializeUsage, setDefaultRuntime, testEngine } =
    await marbles();
  setDefaultRuntime(async () => {
    await initializeUsage();
    return testEngine({ print: () => undefined, root });
  });
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
  await engine.dispose();
  await openHost(() => undefined);
  expect(fake.usage.initialize).toHaveBeenCalledTimes(2);
  await expect(check.run()).resolves.toMatchObject({ name: "anthropic" });
});
