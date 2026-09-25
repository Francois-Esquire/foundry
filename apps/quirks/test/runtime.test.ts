import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspaces } from "@foundry/quirks";
import { expect, it, vi } from "vitest";

import type * as Harnesses from "~/harnesses";

import { registry } from "~/lib/registry";
import { bindRuntime } from "~/runtime";

vi.mock("~/harnesses", async (importOriginal) => ({
  ...(await importOriginal<typeof Harnesses>()),
  detectHarnesses: () => ({ claudeCode: false, codex: null }),
}));

it("exposes directory cataloguing and dry-run Git through Workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-"));
  const lines: string[] = [];
  const runtime = bindRuntime({
    dry: true,
    only: [],
    print: (line) => lines.push(line),
    root,
  });
  try {
    // Nothing is installed, yet --dry still echoes every harness.
    expect(
      runtime.primitives.executors.map((executor) => executor.harness)
    ).toEqual(["claude-code", "codex"]);
    await writeFile(join(root, "notes.md"), "initial");
    const workspaces: Workspaces = runtime.primitives.workspaces;
    const { load } = workspaces;
    const workspace = await load({ path: root });
    expect(await workspace.files()).toMatchObject([{ path: "notes.md" }]);
    expect((await load({ path: root })).id).toBe(workspace.id);

    const worktree = await workspaces.git(root).worktree({ base: "HEAD" });
    expect(lines.some((line) => line.includes("git worktree add"))).toBe(true);
    await worktree.remove();
    await workspace.remove();
  } finally {
    await runtime.dispose();
    registry.reset();
    await rm(root, { force: true, recursive: true });
  }
});

it("runs deterministic steps without an installed harness", async () => {
  const runtime = bindRuntime({
    dry: false,
    only: [],
    print: () => undefined,
    root: process.cwd(),
  });
  try {
    expect(runtime.primitives.executors).toEqual([]);
    const count = registry.step("count", (_, input: string) =>
      Promise.resolve(input.length)
    );
    await expect(count.create().run("hello")).resolves.toBe(5);
  } finally {
    await runtime.dispose();
    registry.reset();
  }
});
