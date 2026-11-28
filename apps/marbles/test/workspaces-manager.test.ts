import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ensureWorktreeDir,
  localWorkspaces,
  nodeGitAt,
} from "~/host/workspaces";
import { WorkspacesManager } from "~/lib/managers/workspaces";
import type { ExecutionContext } from "~/lib/runs/context";
import { activeContext } from "~/lib/runs/context";
import type { Current } from "~/lib/runs/scope";
import { current } from "~/lib/runs/scope";
import { seedRepository } from "./helpers/repository";

const contextOf = (workspaceId: string, cwd: string): ExecutionContext => ({
  cwd,
  environment: {},
  workspaceId,
});

it("runs a worktree callback as its own engine's work inside another engine's run", async () => {
  const root = await seedRepository();
  const home = mkdtempSync(join(tmpdir(), "marbles-worktrees-"));
  const mine = contextOf("mine", root);
  const theirs = contextOf("theirs", "/elsewhere");
  const manager = new WorkspacesManager({
    catalogue: localWorkspaces({}),
    context: mine,
    ensureDir: ensureWorktreeDir,
    gitAt: nodeGitAt(),
    root,
    worktreeHome: home,
  });
  const foreign = { bindings: { context: theirs }, cwd: "/elsewhere" };
  try {
    const seen = await current.run(foreign as unknown as Current, () =>
      manager.current.git.withWorktree({ base: "main" }, () =>
        Promise.resolve({
          context: activeContext(),
          store: current.getStore(),
        })
      )
    );
    expect(seen.store).toBeUndefined();
    expect(seen.context).toBe(mine);
  } finally {
    await manager.close();
    rmSync(home, { force: true, recursive: true });
    rmSync(root, { force: true, recursive: true });
  }
});

it("keeps its own run and moves it into the worktree", async () => {
  const root = await seedRepository();
  const home = mkdtempSync(join(tmpdir(), "marbles-worktrees-"));
  const mine = contextOf("mine", root);
  const manager = new WorkspacesManager({
    catalogue: localWorkspaces({}),
    context: mine,
    ensureDir: ensureWorktreeDir,
    gitAt: nodeGitAt(),
    root,
    worktreeHome: home,
  });
  const own = { bindings: { context: mine }, cwd: root };
  try {
    const seen = await current.run(own as unknown as Current, () =>
      manager.current.git.withWorktree({ base: "main" }, (worktree) =>
        Promise.resolve({ root: worktree.root, store: current.getStore() })
      )
    );
    expect(seen.store?.bindings).toBe(own.bindings);
    expect(seen.store?.cwd).toBe(seen.root);
  } finally {
    await manager.close();
    rmSync(home, { force: true, recursive: true });
    rmSync(root, { force: true, recursive: true });
  }
});
