import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@foundry/models";
import { agent, step } from "@foundry.sh/marbles";
import { Output } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Catalog, catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { DatabaseProviderStore } from "~/database/providers";
import { stateDatabase } from "~/layout";
import { Engine } from "~/lib/engine";
import { vercel } from "~/lib/providers/vercel";
import { RunScope } from "~/lib/run-scope";

import { fakeCodex } from "./helpers/codex";
import { testInstances } from "./helpers/engine";
import { bindLaunch, launch } from "./helpers/launch";

const NOT_A_REPOSITORY = /not a git repository/;
const ECHOED_EXEC = /^\[exec\] .*git status$/;
const ECHOED_TURN = /^\[paid\/chosen\] /;

afterEach(() => {
  catalog.reset();
});

it("exposes the config directory and dry-run git through the engine's workspaces", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-")));
  const lines: string[] = [];
  const engine = createEngine({
    catalog,
    dry: true,
    print: (line) => lines.push(line),
    root,
    workspaceId: "ws",
  });
  const scope = new RunScope("runtime-test", root);
  try {
    await engine.providers?.refresh();
    expect(engine.harnesses).toEqual(["claude-code", "codex"]);
    await writeFile(join(root, "notes.md"), "initial");
    const workspaces = engine.bindings.workspaces({
      frame: scope.frame(["root"]),
      scope,
      write: () => undefined,
    });
    expect(workspaces.current.root).toBe(root);
    const files = await workspaces.current.files();
    expect(files.map((file) => file.path)).toContain("notes.md");
    const loaded = await workspaces.load({ path: root });
    expect(loaded.root).toBe(root);
    expect(() => workspaces.current.git).toThrow(NOT_A_REPOSITORY);

    await mkdir(join(root, ".git"));
    const seen = await workspaces.current.git.withWorktree(
      { base: "HEAD" },
      (worktree) => Promise.resolve(worktree.root)
    );
    expect(seen).not.toBe(root);
    expect(lines.some((line) => line.includes("git worktree add"))).toBe(true);
    expect(lines.some((line) => line.includes("git worktree remove"))).toBe(
      true
    );
    expect(existsSync(seen)).toBe(false);
  } finally {
    await scope.settle();
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it("echoes git under dry in the workspace system the engine builds, too", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-git-")));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const lines: string[] = [];
  const engine = createEngine({
    catalog,
    dry: true,
    print: (line) => lines.push(line),
    root,
    workspaceId: "ws",
  });
  try {
    const loaded = await engine.workspaces.system.load({ path: root });
    await loaded.git?.withWorktree({ base: "HEAD" }, () => Promise.resolve());
    expect(lines.some((line) => line.includes("git worktree add"))).toBe(true);
  } finally {
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it("builds an engine with no providers from an empty plugin list and an empty catalog", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-")));
  const engine = createEngine({
    catalog: new Catalog(),
    dry: true,
    plugins: [],
    print: () => undefined,
    root,
    workspaceId: "ws",
  });
  try {
    await engine.providers?.refresh();
    expect(engine.harnesses).toEqual([]);
    expect(engine.models.providers).toEqual([]);
    expect(engine.providers?.list().length).toBeGreaterThan(0);
    expect(
      engine.providers
        ?.list()
        .every((entry) => entry.problem?.includes("does not define"))
    ).toBe(true);
  } finally {
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it("refuses a plugin given to the engine under the id of a provider the workspace defined", () => {
  const defined = new Catalog();
  defined.provide(vercel, undefined);
  expect(() =>
    createEngine({
      catalog: defined,
      dry: true,
      plugins: [{ ...vercel }],
      print: () => undefined,
      root: process.cwd(),
      workspaceId: "ws",
    })
  ).toThrow(
    "provider \"vercel\" is defined by the workspace's source and is also one of the engine's own plugins"
  );
  const same = createEngine({
    catalog: defined,
    dry: true,
    plugins: [vercel],
    print: () => undefined,
    root: process.cwd(),
    workspaceId: "ws",
  });
  return same.dispose();
});

it("runs deterministic steps without any provider", async () => {
  const engine = createEngine({
    catalog,
    dry: false,
    print: () => undefined,
    providers: [],
    root: process.cwd(),
    workspaceId: "ws",
  });
  try {
    expect(engine.harnesses).toEqual([]);
    bindLaunch(engine.bindings);
    const count = step("count")
      .input(z.object({ text: z.string() }))
      .do(({ input }) => input.text.length);
    await expect(launch(count, { text: "hello" })).resolves.toBe(5);
  } finally {
    await engine.dispose();
  }
});

it("persists nothing under dry, even when handed a state dir", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "create-dry-"));
  const reviewer = agent({ prompt: "Review." });
  step("review").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    return (await session.generate("Look.")).text;
  });
  const engine = createEngine({
    catalog,
    dry: true,
    print: () => undefined,
    root: process.cwd(),
    stateDir,
    workspaceId: "ws",
  });
  try {
    expect(engine.state).toBeUndefined();
    await engine.start();
    await engine.run("review", {});
    await engine.stop();
    await engine.dispose();
    expect(await readdir(stateDir)).toEqual([]);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

it("keeps a persisting engine's worktrees under its state dir", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "create-state-"));
  const engine = createEngine({
    catalog,
    dry: false,
    print: () => undefined,
    root: process.cwd(),
    stateDir,
    workspaceId: "ws",
  });
  try {
    expect(engine.state).toBe(stateDir);
    expect(engine.worktrees).toBe(join(stateDir, "worktrees"));
  } finally {
    await engine.dispose();
    await rm(stateDir, { force: true, recursive: true });
  }
});

it("declares the config to the engine it builds", () => {
  step("count").do(() => 1);
  const engine = createEngine({
    catalog,
    dry: true,
    print: () => undefined,
    root: process.cwd(),
    workspaceId: "ws",
  });
  expect(engine.definitions().map((entry) => entry.name)).toEqual(["count"]);
  expect([...catalog.definitions.keys()]).toEqual(["count"]);
  expect(engine.has("__automation_monitor")).toBe(true);
});

it("builds an engine over the instances a host hands in", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "create-")));
  const instances = testInstances({ root });
  const engine = new Engine({ ...instances, root, workspaceId: "ws" });
  const reviewer = agent({ prompt: "Review." });
  engine.define(
    step("review").do(async ({ agents, workspaces: seen }) => {
      const session = await agents.session(reviewer);
      await session.generate("Look.");
      return { root: seen.current.root, session: session.ref.id };
    })
  );
  try {
    expect(engine.models).toBe(instances.models);
    expect(engine.sessions).toBe(instances.sessions);
    expect(engine.workspaces.system).toBe(instances.workspaces);
    await engine.start();
    const result = await engine.run<{ root: string; session: string }>(
      "review",
      {}
    );
    expect(result.root).toBe(root);
    await expect(
      instances.sessions.getSession(result.session)
    ).resolves.toBeDefined();
  } finally {
    await engine.stop();
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it("runs model-free work without provider configuration, and refuses a session with guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-unconfigured-"));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot);
  const reviewer = agent({ prompt: "Review." });
  step("count").do(() => 1);
  step("review").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    return (await session.generate("Look.")).text;
  });
  const engine = createEngine({
    catalog,
    dry: true,
    print: () => undefined,
    root: process.cwd(),
    stateRoot,
    workspaceId: "ws",
  });
  try {
    await engine.start();
    await expect(engine.run("count", {})).resolves.toBe(1);
    await expect(engine.run("review", {})).rejects.toThrow(
      "No model providers are configured. Run marbles without --dry-run in a terminal to set them up."
    );
    await engine.providers?.add(
      { id: "codex", plugin: "codex", settings: { binPath: fakeCodex(root) } },
      { scope: "machine" }
    );
    expect(engine.providers?.list().map((entry) => entry.id)).toEqual([
      "codex",
    ]);
    expect(await readdir(stateRoot)).toEqual([]);
  } finally {
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it("echoes the configured providers under dry, and lets a programmatic set supersede them", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "create-configured-"));
  await DatabaseProviderStore.forState(stateRoot).update(undefined, () => ({
    machine: {
      providers: [
        {
          enabled: true,
          id: "codex",
          plugin: "codex",
          settings: { binPath: fakeCodex(stateRoot) },
        },
      ],
      version: 1,
    },
  }));
  const before = await readFile(stateDatabase(stateRoot));
  const base = {
    catalog,
    print: () => undefined,
    root: process.cwd(),
    stateRoot,
    workspaceId: "ws",
  };
  const dry = createEngine({ ...base, dry: true });
  const programmatic = createEngine({ ...base, dry: false, providers: [] });
  await dry.providers?.refresh();
  try {
    expect(dry.models.providers.map((provider) => provider.id)).toEqual([
      "codex",
    ]);
    expect(dry.providers?.list().map((entry) => entry.state)).toEqual([
      "ready",
    ]);
    expect(programmatic.models.providers).toEqual([]);
    const session = await dry.agents.session({
      id: "reviewer",
      kind: "agent",
      model: "gpt-5.5",
      prompt: "Review.",
      provider: "codex",
    });
    await session.generate("Look.");
    expect(session.ref.instance).toEqual(expect.any(String));
    expect(
      await DatabaseProviderStore.forState(stateRoot).identityKey(false)
    ).toBeUndefined();
    expect((await readFile(stateDatabase(stateRoot))).equals(before)).toBe(
      true
    );
  } finally {
    await Promise.all([dry.dispose(), programmatic.dispose()]);
    await rm(stateRoot, { force: true, recursive: true });
  }
});

it("echoes a programmatic set under dry, so a supplied provider is never called", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "create-dry-fixed-"));
  const languageModel = vi.fn(() => {
    throw new Error("the real provider was called");
  });
  const dispose = vi.fn(() => Promise.resolve());
  const real: Provider = {
    available: true,
    defaults: { text: "chosen" },
    dispose,
    id: "paid",
    languageModel,
    models: [
      { id: "m", kind: "text", modelId: "m" },
      { id: "chosen", kind: "text", modelId: "chosen" },
    ],
  };
  const lines: string[] = [];
  const engine = createEngine({
    catalog,
    dry: true,
    print: (line) => lines.push(line),
    providers: [real],
    root: process.cwd(),
    stateRoot,
    workspaceId: "ws",
  });
  try {
    const session = await engine.agents.session({
      id: "reviewer",
      kind: "agent",
      prompt: "Review.",
    });
    await session.generate("Look.");
    expect(languageModel).not.toHaveBeenCalled();
    expect(lines.some((line) => line.includes("[paid/chosen]"))).toBe(true);
  } finally {
    await engine.dispose();
    await rm(stateRoot, { force: true, recursive: true });
  }
  expect(dispose).toHaveBeenCalledTimes(1);
});

it("answers every dry-run command and model turn with the same fixed reply", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "create-dry-replies-"));
  const real: Provider = {
    available: true,
    defaults: { text: "chosen" },
    id: "paid",
    languageModel: () => {
      throw new Error("the real provider was called");
    },
    models: [{ id: "chosen", kind: "text", modelId: "chosen" }],
  };
  const lines: string[] = [];
  step("on-host").do(({ exec }) => exec(["git", "status"]));
  step("in-sandbox").do(async ({ sandboxes }) => {
    const box = await sandboxes.start({ image: "docker.io/oven/bun:1-slim" });
    return box.exec(["make", "test"]);
  });
  const engine = createEngine({
    catalog,
    dry: true,
    print: (line) => lines.push(line),
    providers: [real],
    root: process.cwd(),
    stateRoot,
    workspaceId: "ws",
  });
  try {
    await engine.start();
    await expect(engine.run("on-host", {})).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "",
    });
    await expect(engine.run("in-sandbox", {})).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "",
    });
    expect(lines).toContainEqual(expect.stringMatching(ECHOED_EXEC));
    expect(lines).toContain("[sandbox] make test");
    const session = await engine.agents.session({
      id: "reviewer",
      kind: "agent",
      prompt: "Review.",
    });
    const text = await session.generate("Look.");
    expect(text.text).toMatch(ECHOED_TURN);
    expect(text.text).toContain("Look.");
    const verdict = await session.generate("Decide.", {
      output: Output.object({
        schema: z.object({ verdict: z.enum(["approve", "reject"]) }),
      }),
    });
    expect(verdict.output).toEqual({ verdict: "approve" });
  } finally {
    await engine.dispose();
    await rm(stateRoot, { force: true, recursive: true });
  }
});
