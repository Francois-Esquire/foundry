import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
import { step } from "@foundry/quirks";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as Harnesses from "~/harnesses";
import { catalog } from "~/lib/catalog";
import { RunScope, runs } from "~/lib/run-scope";
import { bindRuntime } from "~/runtime";

import { launch } from "./helpers/launch";

vi.mock("~/harnesses", async (importOriginal) => ({
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

it("exposes the config directory and dry-run git through the bound workspaces", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-")));
  const lines: string[] = [];
  const runtime = bindRuntime({
    artifacts: artifacts(),
    dry: true,
    only: [],
    print: (line) => lines.push(line),
    root,
    workspaceId: "ws",
  });
  const scope = new RunScope("runtime-test", root);
  try {
    // Nothing is installed, yet --dry still echoes every harness.
    expect(runtime.harnesses).toEqual(["claude-code", "codex"]);
    await writeFile(join(root, "notes.md"), "initial");
    const workspaces = runtime.bindings.workspaces({
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
    await runtime.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it("runs deterministic steps without an installed harness", async () => {
  const runtime = bindRuntime({
    artifacts: artifacts(),
    dry: false,
    only: [],
    print: () => undefined,
    root: process.cwd(),
    workspaceId: "ws",
  });
  try {
    expect(runtime.harnesses).toEqual([]);
    const count = step("count")
      .input(z.object({ text: z.string() }))
      .do(({ input }) => input.text.length);
    await expect(launch(count, { text: "hello" })).resolves.toBe(5);
  } finally {
    await runtime.dispose();
  }
});
