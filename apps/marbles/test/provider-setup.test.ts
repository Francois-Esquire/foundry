import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@foundry/models";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { DatabaseProviderStore } from "~/database/providers";
import { registered } from "~/lib/providers/plugins";
import { setupProviders } from "~/workspace/provider-setup";

let state: string;

const detected = (id: string, found: boolean) =>
  registered({
    catalog: () => [],
    create: ({ id: name }) => ({
      provider: {
        available: true,
        id: name,
        languageModel: () => ({}) as never,
        models: [],
        offline: false,
      } satisfies Provider,
    }),
    detect: () => (found ? {} : null),
    id,
    label: id.toUpperCase(),
    settings: z.object({}),
  });

const PLUGINS = [
  detected("codex", true),
  detected("pi", false),
  detected("claude-code", true),
];

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "marbles-setup-"));
});

afterEach(() => {
  rmSync(state, { force: true, recursive: true });
});

async function machineIds(): Promise<string[] | undefined> {
  return (
    await DatabaseProviderStore.forState(state).read()
  ).machine?.providers.map((entry) => entry.id);
}

async function configure(
  ids: readonly string[],
  scope?: string
): Promise<void> {
  const configuration = {
    providers: ids.map((id) => ({ enabled: true, id, plugin: id })),
    version: 1 as const,
  };
  await DatabaseProviderStore.forState(state).update(scope, () =>
    scope === undefined
      ? { machine: configuration }
      : { workspace: configuration }
  );
}

it("writes what was detected, in order, only once confirmed", async () => {
  const lines: string[] = [];
  await setupProviders({
    confirm: () => Promise.resolve(true),
    plugins: PLUGINS,
    print: (line) => lines.push(line),
    state,
  });
  expect(await machineIds()).toEqual(["codex", "claude-code"]);
  expect(lines).toContain("  1. codex (CODEX)");
});

it("writes nothing when declined, and asks nothing once configured", async () => {
  const confirm = vi.fn(() => Promise.resolve(false));
  await setupProviders({
    confirm,
    plugins: PLUGINS,
    print: () => undefined,
    state,
  });
  expect(await machineIds()).toBeUndefined();

  await setupProviders({
    confirm: () => Promise.resolve(true),
    plugins: PLUGINS,
    print: () => undefined,
    state,
  });
  confirm.mockClear();
  await setupProviders({
    confirm,
    plugins: PLUGINS,
    print: () => undefined,
    state,
  });
  expect(confirm).not.toHaveBeenCalled();
});

it("leaves out an id a workspace already uses, and never fails on it", async () => {
  await configure(["claude-code"], "abc123");
  const lines: string[] = [];
  for (const _run of [1, 2]) {
    await setupProviders({
      confirm: () => Promise.resolve(false),
      plugins: [detected("claude-code", true)],
      print: (line) => lines.push(line),
      state,
    });
  }
  expect(await machineIds()).toBeUndefined();
  expect(
    lines.filter((line) => line.includes("workspace abc123"))
  ).toHaveLength(2);
  expect(lines).toContain("Nothing else to offer for the whole machine.");
  await setupProviders({
    confirm: () => Promise.resolve(true),
    plugins: PLUGINS,
    print: () => undefined,
    state,
  });
  expect(await machineIds()).toEqual(["codex"]);
});

it("keeps a configuration another process wrote while the question was open", async () => {
  const lines: string[] = [];
  await setupProviders({
    confirm: async () => {
      await configure(["pi"]);
      return true;
    },
    plugins: PLUGINS,
    print: (line) => lines.push(line),
    state,
  });
  expect(await machineIds()).toEqual(["pi"]);
  expect(lines.at(-1)).toContain("were configured meanwhile");
});

it("asks nothing when the workspace being run has its own providers", async () => {
  const dir = join(state, "ws1");
  await configure(["codex"], "ws1");
  const confirm = vi.fn(() => Promise.resolve(true));
  await setupProviders({
    confirm,
    plugins: PLUGINS,
    print: () => undefined,
    state,
    workspace: { dir, id: "ws1", root: "/repo" },
  });
  expect(confirm).not.toHaveBeenCalled();
  expect(await machineIds()).toBeUndefined();
});

it("saves nothing when a workspace takes an offered id while the question is open", async () => {
  const lines: string[] = [];
  await setupProviders({
    confirm: async () => {
      await configure(["codex"], "other");
      return true;
    },
    plugins: PLUGINS,
    print: (line) => lines.push(line),
    state,
  });
  expect(await machineIds()).toBeUndefined();
  expect(lines.at(-1)).toContain("Nothing saved");
  expect(lines.at(-1)).toContain("workspace other");
});
