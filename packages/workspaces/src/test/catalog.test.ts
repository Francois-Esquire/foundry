import { describe, expect, test } from "vitest";
import { WorkspaceCatalog } from "../catalog";
import { MemoryWorkspaceStore } from "../memory-store";
import type {
  WorkspaceCatalogChange,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceFile,
} from "../types";
import {
  artifactWorkspace,
  directoryRecord,
  fileRecord,
  hostWorkspace,
  newRoot,
  newWorkspaceEntryId,
  newWorkspaceId,
} from "./helpers/fixtures";

const EDITED_DIGEST =
  "1fb9f4097256db2d7b1e13aff79cee44339891a31c556b9cf6093885773b3618";

function fixture() {
  const store = new MemoryWorkspaceStore();
  const published: WorkspaceChange[] = [];
  const catalog = new WorkspaceCatalog(store, (changes) => {
    published.push(...changes);
  });
  return { catalog, published, store };
}

function change(
  parts: Partial<WorkspaceCatalogChange>
): WorkspaceCatalogChange {
  return { deleted: [], inserted: [], updated: [], ...parts };
}

describe("WorkspaceCatalog", () => {
  test("registers a Workspace with every entry type and counts only regular files", async () => {
    const { catalog, published } = fixture();
    const workspace = hostWorkspace({ path: newRoot("entries") });
    const file = fileRecord(workspace.id, { path: "file.txt" });
    const entries: WorkspaceEntry[] = [
      { ...directoryRecord(workspace.id, "device"), type: "device" },
      directoryRecord(workspace.id, "empty"),
      file,
      {
        ...directoryRecord(workspace.id, "link"),
        target: "../missing",
        type: "symlink",
      },
      { ...directoryRecord(workspace.id, "pipe"), type: "pipe" },
      { ...directoryRecord(workspace.id, "socket"), type: "socket" },
    ];

    expect(await catalog.create({ entries, workspace })).toEqual({
      kind: "committed",
    });
    expect(await catalog.getWorkspace(workspace.id)).toEqual(workspace);
    expect(await catalog.listEntries(workspace.id)).toEqual(entries);
    expect(await catalog.getEntry(workspace.id, file.id)).toEqual(file);
    expect(await catalog.countFiles(workspace.id)).toBe(1);
    expect(published).toEqual(
      entries.map((entry) => ({ action: "add", entry }))
    );
  });

  test("refuses entries that belong to another Workspace at registration", async () => {
    const { catalog } = fixture();
    const workspace = hostWorkspace({ path: newRoot("foreign") });
    const foreign = fileRecord(newWorkspaceId(), { path: "README.md" });

    await expect(
      catalog.create({ entries: [foreign], workspace })
    ).rejects.toThrow("does not belong");
    expect(await catalog.getWorkspace(workspace.id)).toBeNull();
  });

  test("resolves a second Workspace over one root to the first", async () => {
    const { catalog, published } = fixture();
    const root = newRoot("alpha");
    const first = hostWorkspace({ path: root });
    await catalog.create({ entries: [], workspace: first });
    const second = hostWorkspace({ path: root });

    expect(
      await catalog.create({
        entries: [fileRecord(second.id, { path: "README.md" })],
        workspace: second,
      })
    ).toEqual({ existingId: first.id, kind: "workspace-exists" });
    expect(await catalog.getWorkspace(second.id)).toBeNull();
    expect(published).toEqual([]);
  });

  test("resolves a second Workspace over one source reference to the first", async () => {
    const { catalog } = fixture();
    const artifactId = crypto.randomUUID();
    const first = artifactWorkspace(artifactId, newRoot("first"));
    await catalog.create({ entries: [], workspace: first });

    expect(
      await catalog.create({
        entries: [],
        workspace: artifactWorkspace(artifactId, newRoot("second")),
      })
    ).toEqual({ existingId: first.id, kind: "workspace-exists" });
  });

  test("resolves a candidate that collides on both rules to the root's owner", async () => {
    const { catalog } = fixture();
    const sharedSourceId = crypto.randomUUID();
    const contestedRoot = newRoot("contested");
    const byReference = artifactWorkspace(sharedSourceId, newRoot("first"));
    const byRoot = artifactWorkspace(crypto.randomUUID(), contestedRoot);
    await catalog.create({ entries: [], workspace: byReference });
    await catalog.create({ entries: [], workspace: byRoot });

    expect(
      await catalog.create({
        entries: [],
        workspace: artifactWorkspace(sharedSourceId, contestedRoot),
      })
    ).toEqual({ existingId: byRoot.id, kind: "workspace-exists" });
  });

  test("lets exactly one of two concurrent registrations over one root win", async () => {
    const { catalog } = fixture();
    const root = newRoot("race");
    const first = hostWorkspace({ path: root });
    const second = hostWorkspace({ path: root });

    const results = await Promise.all([
      catalog.create({ entries: [], workspace: first }),
      catalog.create({ entries: [], workspace: second }),
    ]);

    expect(results).toEqual([
      { kind: "committed" },
      { existingId: first.id, kind: "workspace-exists" },
    ]);
  });

  test("applies one change as a whole and publishes it", async () => {
    const { catalog, published } = fixture();
    const workspace = hostWorkspace({ path: newRoot("alpha") });
    const kept = fileRecord(workspace.id, { path: "README.md" });
    const removed = fileRecord(workspace.id, { path: "old.md" });
    await catalog.create({ entries: [kept, removed], workspace });
    published.length = 0;

    const edited: WorkspaceFile = {
      ...kept,
      bytes: 12,
      digest: EDITED_DIGEST,
      updatedAt: new Date(5000),
    };
    const src = directoryRecord(workspace.id, "src");
    const added = fileRecord(workspace.id, { path: "src/new.ts" });

    expect(
      await catalog.applyChange({
        change: change({
          deleted: [removed],
          inserted: [src, added],
          updated: [edited],
        }),
        lastReconciledAt: new Date(5000),
        updatedAt: new Date(5000),
        workspaceId: workspace.id,
      })
    ).toEqual({ kind: "committed" });

    expect(await catalog.listEntries(workspace.id)).toEqual([
      edited,
      src,
      added,
    ]);
    expect(await catalog.getWorkspace(workspace.id)).toMatchObject({
      lastReconciledAt: new Date(5000),
      updatedAt: new Date(5000),
    });
    expect(published).toEqual([
      { action: "delete", entry: removed },
      { action: "change", entry: edited },
      { action: "add", entry: src },
      { action: "add", entry: added },
    ]);
  });

  test("records a one-File update without touching freshness", async () => {
    const { catalog } = fixture();
    const workspace = hostWorkspace({ path: newRoot("written") });
    const file = fileRecord(workspace.id, { path: "notes.md" });
    const sibling = fileRecord(workspace.id, { path: "other.md" });
    await catalog.create({ entries: [file, sibling], workspace });
    const updatedAt = new Date(file.updatedAt.getTime() + 5000);
    const written = { ...file, bytes: 42, digest: EDITED_DIGEST, updatedAt };

    expect(
      await catalog.applyChange({
        change: change({ updated: [written] }),
        updatedAt,
        workspaceId: workspace.id,
      })
    ).toEqual({ kind: "committed" });

    expect(await catalog.getEntry(workspace.id, file.id)).toEqual(written);
    expect(await catalog.getEntry(workspace.id, sibling.id)).toEqual(sibling);
    expect(await catalog.getWorkspace(workspace.id)).toMatchObject({
      lastReconciledAt: workspace.lastReconciledAt,
      updatedAt,
    });
  });

  test("advances freshness strictly when stale callers propose the same observation time", async () => {
    const { catalog } = fixture();
    const workspace = hostWorkspace({ path: newRoot("freshness") });
    await catalog.create({ entries: [], workspace });
    const input = {
      change: change({}),
      lastReconciledAt: new Date(1001),
      workspaceId: workspace.id,
    };

    await catalog.applyChange(input);
    const first = await catalog.getWorkspace(workspace.id);
    await catalog.applyChange(input);
    const second = await catalog.getWorkspace(workspace.id);

    expect(first?.lastReconciledAt.getTime()).toBeGreaterThan(
      workspace.lastReconciledAt.getTime()
    );
    expect(second?.lastReconciledAt.getTime()).toBeGreaterThan(
      first?.lastReconciledAt.getTime() ?? 0
    );
  });

  test("moves one File onto a path the same change frees", async () => {
    const { catalog } = fixture();
    const workspace = hostWorkspace({ path: newRoot("alpha") });
    const target = fileRecord(workspace.id, { path: "README.md" });
    const docs = directoryRecord(workspace.id, "docs");
    const traveller = fileRecord(workspace.id, { path: "docs/README.md" });
    await catalog.create({ entries: [target, docs, traveller], workspace });

    // `diffCatalog` cannot emit this shape — a candidate at an existing row's
    // path matches that row — but the catalog must not depend on that: paths
    // only have to be unique once the whole change is applied.
    const arrived: WorkspaceFile = {
      ...traveller,
      path: "README.md",
      updatedAt: new Date(6000),
    };

    expect(
      await catalog.applyChange({
        change: change({ deleted: [target], updated: [arrived] }),
        workspaceId: workspace.id,
      })
    ).toEqual({ kind: "committed" });
    expect(await catalog.listEntries(workspace.id)).toEqual([arrived, docs]);
  });

  test("refuses a change that leaves an invalid tree, changing nothing", async () => {
    const { catalog, published } = fixture();
    const workspace = hostWorkspace({ path: newRoot("structure") });
    const parent = directoryRecord(workspace.id, "src");
    const child = fileRecord(workspace.id, { path: "src/file.ts" });
    const kept = fileRecord(workspace.id, { path: "README.md" });
    await catalog.create({ entries: [parent, child, kept], workspace });
    const before = await catalog.getWorkspace(workspace.id);
    published.length = 0;

    const orphaning = change({ deleted: [parent] });
    const colliding = change({
      // The edit and the delete would apply before the collision; none of
      // them may survive the refusal.
      deleted: [child],
      inserted: [
        fileRecord(workspace.id, { path: "added.md" }),
        fileRecord(workspace.id, { path: "added.md" }),
      ],
      updated: [{ ...kept, digest: EDITED_DIGEST }],
    });
    for (const refused of [orphaning, colliding]) {
      expect(
        await catalog.applyChange({
          change: refused,
          lastReconciledAt: new Date(9000),
          updatedAt: new Date(9000),
          workspaceId: workspace.id,
        })
      ).toMatchObject({ kind: "conflict" });
    }

    expect(await catalog.listEntries(workspace.id)).toEqual([
      kept,
      parent,
      child,
    ]);
    expect(await catalog.getWorkspace(workspace.id)).toEqual(before);
    expect(published).toEqual([]);
  });

  test("refuses a change that names rows this Workspace does not hold", async () => {
    const { catalog } = fixture();
    const mine = hostWorkspace({ path: newRoot("mine") });
    const theirs = hostWorkspace({ path: newRoot("theirs") });
    const kept = fileRecord(mine.id, { path: "README.md" });
    const foreign = fileRecord(theirs.id, { path: "README.md" });
    await catalog.create({ entries: [kept], workspace: mine });
    await catalog.create({ entries: [foreign], workspace: theirs });
    const vanished = fileRecord(mine.id, { path: "gone.md" });

    const refusals = [
      change({ deleted: [vanished] }),
      change({ deleted: [foreign] }),
      change({ updated: [{ ...vanished, digest: EDITED_DIGEST }] }),
      change({ updated: [{ ...foreign, digest: EDITED_DIGEST }] }),
      change({ updated: [{ ...foreign, workspaceId: mine.id }] }),
      change({ inserted: [{ ...kept, path: "copy.md" }] }),
      change({ inserted: [fileRecord(theirs.id, { path: "new.md" })] }),
    ];
    for (const refused of refusals) {
      expect(
        await catalog.applyChange({ change: refused, workspaceId: mine.id })
      ).toMatchObject({ kind: "conflict" });
    }

    expect(await catalog.listEntries(mine.id)).toEqual([kept]);
    expect(await catalog.listEntries(theirs.id)).toEqual([foreign]);
  });

  test("reports a change against an absent Workspace", async () => {
    const { catalog } = fixture();
    expect(
      await catalog.applyChange({
        change: change({}),
        workspaceId: newWorkspaceId(),
      })
    ).toEqual({ kind: "workspace-not-found" });
  });

  test("publishes a delete with the row as stored, not as the caller described it", async () => {
    const { catalog, published } = fixture();
    const workspace = hostWorkspace({ path: newRoot("stored") });
    const file = fileRecord(workspace.id, { path: "README.md" });
    await catalog.create({ entries: [file], workspace });
    published.length = 0;

    await catalog.applyChange({
      change: change({ deleted: [{ ...file, digest: EDITED_DIGEST }] }),
      workspaceId: workspace.id,
    });

    expect(published).toEqual([{ action: "delete", entry: file }]);
  });

  test("renames without publishing, and leaves an unchanged name alone", async () => {
    const { catalog, published } = fixture();
    const workspace = hostWorkspace({ path: newRoot("named") });
    await catalog.create({ entries: [], workspace });
    published.length = 0;

    expect(await catalog.rename(workspace.id, "alpha", new Date(9000))).toEqual(
      workspace
    );
    expect(await catalog.rename(workspace.id, "beta", new Date(9000))).toEqual({
      ...workspace,
      name: "beta",
      updatedAt: new Date(9000),
    });
    expect(await catalog.rename(newWorkspaceId(), "x", new Date())).toBeNull();
    expect(published).toEqual([]);
  });

  test("removes one Workspace with its own entries and publishes their deletes", async () => {
    const { catalog, published } = fixture();
    const first = hostWorkspace({ path: newRoot("alpha") });
    const second = hostWorkspace({ path: newRoot("beta") });
    const firstReadme = fileRecord(first.id, { path: "README.md" });
    const secondReadme = fileRecord(second.id, { path: "README.md" });
    await catalog.create({ entries: [firstReadme], workspace: first });
    await catalog.create({ entries: [secondReadme], workspace: second });
    published.length = 0;

    expect(await catalog.remove(first.id)).toEqual({ kind: "removed" });
    expect(await catalog.getWorkspace(first.id)).toBeNull();
    expect(await catalog.listEntries(first.id)).toEqual([]);
    expect(await catalog.listEntries(second.id)).toEqual([secondReadme]);
    expect(published).toEqual([{ action: "delete", entry: firstReadme }]);
    expect(await catalog.remove(first.id)).toEqual({ kind: "not-found" });
  });

  test("refuses an insert that reuses an entry id", async () => {
    const { catalog } = fixture();
    const workspace = hostWorkspace({ path: newRoot("ids") });
    const file = fileRecord(workspace.id, { path: "a.md" });
    await catalog.create({ entries: [file], workspace });

    expect(
      await catalog.applyChange({
        change: change({
          inserted: [{ ...file, id: newWorkspaceEntryId(), path: "b.md" }],
        }),
        workspaceId: workspace.id,
      })
    ).toEqual({ kind: "committed" });
    expect(
      await catalog.applyChange({
        change: change({ inserted: [{ ...file, path: "c.md" }] }),
        workspaceId: workspace.id,
      })
    ).toMatchObject({ kind: "conflict" });
  });
});
