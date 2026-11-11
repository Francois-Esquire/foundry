import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@foundry/models";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
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

it("writes what was detected, in order, only once confirmed", async () => {
  const lines: string[] = [];
  await setupProviders({
    confirm: () => Promise.resolve(true),
    plugins: PLUGINS,
    print: (line) => lines.push(line),
    state,
  });
  const file = JSON.parse(readFileSync(join(state, "providers.json"), "utf8"));
  expect(file.providers.map((entry: { id: string }) => entry.id)).toEqual([
    "codex",
    "claude-code",
  ]);
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
  expect(existsSync(join(state, "providers.json"))).toBe(false);

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
  mkdirSync(join(state, "abc123"));
  writeFileSync(
    join(state, "abc123", "providers.json"),
    JSON.stringify({
      providers: [{ enabled: true, id: "claude-code", plugin: "claude-code" }],
      version: 1,
    })
  );
  const lines: string[] = [];
  for (const _run of [1, 2]) {
    await setupProviders({
      confirm: () => Promise.resolve(false),
      plugins: [detected("claude-code", true)],
      print: (line) => lines.push(line),
      state,
    });
  }
  expect(existsSync(join(state, "providers.json"))).toBe(false);
  expect(
    lines.filter((line) => line.includes("workspace abc123"))
  ).toHaveLength(2);
  expect(lines).toContain(
    `Nothing else to offer for the whole machine; write ${join(state, "providers.json")} to configure it.`
  );
  await setupProviders({
    confirm: () => Promise.resolve(true),
    plugins: PLUGINS,
    print: () => undefined,
    state,
  });
  const file = JSON.parse(readFileSync(join(state, "providers.json"), "utf8"));
  expect(file.providers.map((entry: { id: string }) => entry.id)).toEqual([
    "codex",
  ]);
});

it("keeps a file another process wrote while the question was open", async () => {
  const path = join(state, "providers.json");
  const theirs = JSON.stringify({
    providers: [{ enabled: true, id: "pi", plugin: "pi" }],
    version: 1,
  });
  const lines: string[] = [];
  await setupProviders({
    confirm: () => {
      writeFileSync(path, theirs);
      return Promise.resolve(true);
    },
    plugins: PLUGINS,
    print: (line) => lines.push(line),
    state,
  });
  expect(readFileSync(path, "utf8")).toBe(theirs);
  expect(lines.at(-1)).toContain("was written meanwhile");
});

it("asks nothing when the workspace being run has its own providers", async () => {
  const dir = join(state, "ws1");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
      version: 1,
    })
  );
  const confirm = vi.fn(() => Promise.resolve(true));
  await setupProviders({
    confirm,
    plugins: PLUGINS,
    print: () => undefined,
    state,
    workspace: { dir, id: "ws1", root: "/repo" },
  });
  expect(confirm).not.toHaveBeenCalled();
  expect(existsSync(join(state, "providers.json"))).toBe(false);
});

it("saves nothing when a workspace takes an offered id while the question is open", async () => {
  const lines: string[] = [];
  await setupProviders({
    confirm: () => {
      mkdirSync(join(state, "other"));
      writeFileSync(
        join(state, "other", "providers.json"),
        JSON.stringify({
          providers: [{ enabled: true, id: "codex", plugin: "codex" }],
          version: 1,
        })
      );
      return Promise.resolve(true);
    },
    plugins: PLUGINS,
    print: (line) => lines.push(line),
    state,
  });
  expect(existsSync(join(state, "providers.json"))).toBe(false);
  expect(lines.at(-1)).toContain("Nothing saved");
  expect(lines.at(-1)).toContain("workspace other");
});
