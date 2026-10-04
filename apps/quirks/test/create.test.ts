import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore } from "@foundry/agents/session";
import { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
import { agent, step } from "@foundry/quirks";
import { WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { catalog } from "~/lib/catalog";
import { createEngine, echoGit } from "~/lib/create";
import type * as Harnesses from "~/lib/harnesses";
import { WorkspacesManager } from "~/lib/managers/workspaces";
import { RunScope, runs } from "~/lib/run-scope";

import { bindLaunch, launch } from "./helpers/launch";

vi.mock("~/lib/harnesses", async (importOriginal) => ({
  ...(await importOriginal<typeof Harnesses>()),
  detectHarnesses: () => ({ claudeCode: false, codex: null }),
}));

const NOT_A_REPOSITORY = /not a git repository/;

afterEach(() => {
  catalog.reset();
  runs.clear();
});

function artifacts() {
  return new ArtifactSystem({ store: new InMemoryArtifactStore() });
}

it("exposes the config directory and dry-run git through the engine's workspaces", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-")));
  const lines: string[] = [];
  const engine = createEngine({
    artifacts: artifacts(),
    catalog,
    dry: true,
    only: [],
    print: (line) => lines.push(line),
    root,
    workspaceId: "ws",
  });
  const scope = new RunScope("runtime-test", root);
  try {
    // Nothing is installed, yet --dry still echoes every harness.
    expect(engine.harnesses).toEqual(["claude-code", "codex"]);
    await writeFile(join(root, "notes.md"), "initial");
    const workspaces = engine.bindings.workspaces({
      cwd: root,
      frame: scope.frame(["root"]),
      scope,
      write: () => undefined,
    });
    expect(workspaces.current.root).toBe(root);
    await expect(workspaces.current.files()).resolves.toContain("notes.md");
    const loaded = await workspaces.load({ path: root });
    expect(loaded.root).toBe(root);
    expect(() => workspaces.current.git).toThrow(NOT_A_REPOSITORY);

    // A `.git` entry is what marks a repository; the git itself is echoed.
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
  } finally {
    await scope.settle();
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it("runs deterministic steps without an installed harness", async () => {
  const engine = createEngine({
    artifacts: artifacts(),
    catalog,
    dry: false,
    only: [],
    print: () => undefined,
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

it("uses the instances a host hands in and builds the rest", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "create-")));
  const sessions = new InMemorySessionStore();
  const workspaces = new WorkspacesManager({
    catalogue: new WorkspaceSystem().extend(
      directory({ observer: nodeObserver }),
      git({ run: echoGit(() => undefined) })
    ),
    root,
  });
  const engine = createEngine({
    artifacts: artifacts(),
    catalog,
    dry: true,
    instances: { sessions, workspaces },
    only: [],
    print: () => undefined,
    root,
    workspaceId: "ws",
  });
  const reviewer = agent({ prompt: "Review." });
  step("review").do(async ({ agents, workspaces: seen }) => {
    const session = await agents.session(reviewer);
    await session.generate("Look.");
    return { root: seen.current.root, session: session.ref.id };
  });
  try {
    expect(engine.workspaces).toBe(workspaces);
    // The agents manager was built here, over the store that was handed in.
    expect(engine.agents.sessions).toBe(sessions);
    await engine.start();
    const result = await engine.run<{ root: string; session: string }>(
      "review",
      {}
    );
    expect(result.root).toBe(root);
    await expect(sessions.getSession(result.session)).resolves.toBeDefined();
  } finally {
    await engine.stop();
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
