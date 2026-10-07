import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidWorkspaceInputError,
  WorkspaceFileNotFoundError,
  WorkspaceNotFoundError,
  WorkspaceSourceUnavailableError,
} from "../errors";
import { MemoryWorkspaceStore } from "../memory-store";
import { nodeFileSystem } from "../node";
import type { WorkspaceFileSystem, WorkspaceId } from "../types";

import { directorySystem } from "./helpers/directory-system";
import { makeRoot, roots, systemOver } from "./helpers/temp-roots";

const FOLDER_CONTENT_PROJECT_ANALYSIS_PATTERN =
  /folder|content|project|analysis/i;

describe("add({ path })", () => {
  it("commits the Workspace and every candidate File together", async () => {
    const root = await makeRoot({
      "README.md": "hello",
      "src/app.ts": "const a = 1;\n",
    });
    const system = directorySystem();

    const workspace = await system.load({ path: root });

    expect(workspace.source).toEqual({
      kind: "host",
      path: root,
      sourceId: null,
    });
    expect(await workspace.summary()).toMatchObject({
      fileCount: 2,
      name: root.split("/").at(-1),
      sourceKind: "host",
    });
    expect((await workspace.files()).map((file) => file.path)).toEqual([
      "README.md",
      "src/app.ts",
    ]);
  });

  it("returns the existing Workspace for a duplicate canonical or symlinked root", async () => {
    const root = await makeRoot({ "README.md": "hi" });
    const linkParent = await mkdtemp(
      join(tmpdir(), "foundry-workspace-alias-")
    );
    roots.push(linkParent);
    const alias = join(linkParent, "alias");
    await symlink(root, alias, "dir");
    const system = directorySystem();

    const first = await system.load({ path: root });

    expect((await system.load({ path: root })).id).toBe(first.id);
    expect((await system.load({ path: alias })).id).toBe(first.id);
    expect((await system.list()).items).toHaveLength(1);
  });

  it("resolves two concurrent adds of one root to a single durable Workspace", async () => {
    const root = await makeRoot({ "README.md": "hi" });
    const system = directorySystem();

    const [left, right] = await Promise.all([
      system.load({ path: root }),
      system.load({ path: root }),
    ]);

    expect(left.id).toBe(right.id);
    expect((await system.list()).items).toHaveLength(1);
  });

  it("creates nothing when the first scan fails", async () => {
    const root = await makeRoot({ "later.md": "bye", "README.md": "hi" });
    const store = new MemoryWorkspaceStore();
    const failing: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile(path) {
        return path.endsWith("later.md")
          ? Promise.reject(new Error("EIO"))
          : nodeFileSystem.readFile(path);
      },
    };
    const system = directorySystem({ filesystem: failing, store });

    await expect(system.load({ path: root })).rejects.toBeInstanceOf(
      WorkspaceSourceUnavailableError
    );
    expect((await store.listWorkspaces()).items).toEqual([]);
  });

  it("refuses a selection that is not a readable directory", async () => {
    const root = await makeRoot({ "README.md": "hi" });
    const system = directorySystem();

    await expect(
      system.load({ path: join(root, "README.md") })
    ).rejects.toBeInstanceOf(InvalidWorkspaceInputError);
  });

  it("refuses a ref no registered floor names, at compile time and at runtime", async () => {
    const system = directorySystem();

    await expect(
      // @ts-expect-error -- `nope` is not a ref any registered floor accepts
      system.load({ nope: "x" })
    ).rejects.toBeInstanceOf(InvalidWorkspaceInputError);
  });
});

describe("reload", () => {
  it("serves the same catalog through a freshly constructed system", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const store = new MemoryWorkspaceStore();
    const added = await systemOver(store).load({ path: root });

    const reloaded = await systemOver(store).open(added.id);

    expect(await reloaded.summary()).toEqual(await added.summary());
    expect((await reloaded.files()).map((f) => f.path)).toEqual(["README.md"]);
  });

  it("reports an unknown Workspace and an unowned File by identity", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem();
    const added = await system.load({ path: root });
    const absent = crypto.randomUUID() as WorkspaceId;

    await expect(system.open(absent)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
    await expect(added.read("not-a-file" as never)).rejects.toBeInstanceOf(
      WorkspaceFileNotFoundError
    );
  });
});

describe("Workspace registration identity and freshness", () => {
  it("keeps source authority trusted, renames without scanning, and records a no-change observation", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const store = new MemoryWorkspaceStore();
    const system = directorySystem({ store });
    const added = await system.load({ path: root });
    const before = await added.registration();

    expect(await added.summary()).not.toHaveProperty("source");
    expect(before.source).toEqual({
      kind: "host",
      path: root,
      sourceId: null,
    });
    expect(before.lastReconciledAt).toEqual(before.createdAt);

    const renamed = await added.rename("  Focused Work  ");
    const afterRename = await added.registration();
    const refreshed = await added.refresh();

    expect(renamed.name).toBe("Focused Work");
    expect(refreshed.workspace.name).toBe("Focused Work");
    expect(refreshed.workspace.updatedAt).toEqual(afterRename.updatedAt);
    expect(refreshed.workspace.lastReconciledAt.getTime()).toBeGreaterThan(
      before.lastReconciledAt.getTime()
    );
  });

  it("refuses an empty name", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const added = await directorySystem().load({ path: root });

    await expect(added.rename("   ")).rejects.toBeInstanceOf(
      InvalidWorkspaceInputError
    );
  });
});

describe("published contracts", () => {
  it("carries the source kind as a label and never a root or reference", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem();
    const added = await system.load({ path: root });
    const summary = await added.summary();
    const files = await added.files();

    const serialized = JSON.stringify({ files, summary });

    expect(summary.sourceKind).toBe("host");
    expect(Object.keys(summary)).not.toContain("path");
    expect(Object.keys(summary)).not.toContain("sourceId");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toMatch(FOLDER_CONTENT_PROJECT_ANALYSIS_PATTERN);
    expect(files[0] && Object.keys(files[0])).not.toContain("content");
  });
});
