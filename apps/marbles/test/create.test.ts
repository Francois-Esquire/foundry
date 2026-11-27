import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent, step } from "@foundry.sh/marbles";
import { expect, it } from "vitest";
import { z } from "zod";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { Engine } from "~/lib/engine";
import { vercel } from "~/lib/providers/vercel";
import { RunScope } from "~/lib/run-scope";

import { fakeCodex } from "./helpers/codex";
import { testInstances } from "./helpers/engine";
import { bindLaunch, launch } from "./helpers/launch";

const NOT_A_REPOSITORY = /not a git repository/;
const _ECHOED_EXEC = /^\[exec\] .*git status$/;
const _ECHOED_TURN = /^\[paid\/chosen\] /;

it("exposes the config directory through the engine's workspaces", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-")));
  const lines: string[] = [];
  const engine = createEngine({
    catalog: new Catalog(),
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
  } finally {
    await scope.settle();
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it("builds an engine with no providers from an empty plugin list and an empty catalog", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-")));
  const engine = createEngine({
    catalog: new Catalog(),
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
    plugins: [vercel],
    print: () => undefined,
    root: process.cwd(),
    workspaceId: "ws",
  });
  return same.dispose();
});

it("runs deterministic steps without any provider", async () => {
  const engine = createEngine({
    catalog: new Catalog(),
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

it("keeps a persisting engine's worktrees under its state dir", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "create-state-"));
  const engine = createEngine({
    catalog: new Catalog(),
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
  const count = step("count").do(() => 1);
  const collected = Catalog.collect([count]);
  const engine = createEngine({
    catalog: collected,
    print: () => undefined,
    root: process.cwd(),
    workspaceId: "ws",
  });
  expect(engine.definitions().map((entry) => entry.name)).toEqual(["count"]);
  expect([...collected.definitions.keys()]).toEqual(["count"]);
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
  const count = step("count").do(() => 1);
  const review = step("review").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    return (await session.generate("Look.")).text;
  });
  const engine = createEngine({
    catalog: Catalog.collect([reviewer, count, review]),
    print: () => undefined,
    root: process.cwd(),
    stateRoot,
    workspaceId: "ws",
  });
  try {
    await engine.start();
    await expect(engine.run("count", {})).resolves.toBe(1);
    await expect(engine.run("review", {})).rejects.toThrow(
      "No model providers are configured. Run marbles in a terminal to set them up."
    );
    await engine.providers?.add(
      { id: "codex", plugin: "codex", settings: { binPath: fakeCodex(root) } },
      { scope: "machine" }
    );
    expect(engine.providers?.list().map((entry) => entry.id)).toEqual([
      "codex",
    ]);
  } finally {
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
