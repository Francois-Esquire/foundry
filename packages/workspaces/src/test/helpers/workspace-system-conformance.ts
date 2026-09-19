import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { DirectoryRef } from "../../directory";
import { sha256Hex } from "../../node";
import type {
  AnyWorkspaceExtension,
  StoredWorkspaceRecord,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceExtension,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceStore,
} from "../../types";
import type { WorkspaceSystem } from "../../workspace-system";

export interface WorkspaceSystemConformanceHarness {
  /**
   * The same store that system was constructed with. Supplied rather than read
   * back off the system, so persistence semantics can be asserted without the
   * system publishing its store to production callers.
   */
  readonly store: WorkspaceStore;
  /**
   * Driven by the public-operation cases: add, list, and read. Must have the
   * directory layer registered, and a floor for every source the store-level
   * cases write (`artifact`, see `emptyLayer`) when cases share one store.
   */
  readonly system: WorkspaceSystem<
    [WorkspaceExtension<DirectoryRef>, ...AnyWorkspaceExtension[]]
  >;
}

export type WorkspaceSystemConformanceFactory = () =>
  | WorkspaceSystemConformanceHarness
  | Promise<WorkspaceSystemConformanceHarness>;

/**
 * The store-neutral behavior suite for the package-owned WorkspaceSystem.
 *
 * A store supplies only construction. The same assertions run unchanged over
 * the in-memory default and the durable SQLite adapter, so a durable store can
 * add migration, constraint, and restart proof without restating semantics.
 */
export function describeWorkspaceSystemConformance(
  name: string,
  createHarness: WorkspaceSystemConformanceFactory
): void {
  describe(`${name} WorkspaceSystem conformance`, () => {
    test("round-trips every entry type and counts only regular files", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("entries") });
      const file = fileRecord(workspace.id, { path: "file.txt" });
      const device = {
        ...directoryRecord(workspace.id, "device"),
        type: "device" as const,
      };
      const entries: WorkspaceEntry[] = [
        device,
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
      await store.commitCreate({ entries, workspace });
      expect(await store.listEntries(workspace.id)).toEqual(entries);
      expect(await store.countFiles(workspace.id)).toBe(1);
      const {
        id: _id,
        workspaceId: _workspaceId,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...observed
      } = file;
      expect(
        await store.commitFileObservation({
          fileId: device.id,
          observed: { ...observed, path: "device" },
          updatedAt: new Date(5000),
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "file-not-found" });
      expect(await store.listEntries(workspace.id)).toEqual(entries);
    });

    test("rejects removing a parent while its child remains, atomically", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("structure") });
      const parent = directoryRecord(workspace.id, "src");
      const file = fileRecord(workspace.id, { path: "src/file.ts" });
      await store.commitCreate({ entries: [parent, file], workspace });
      expect(
        await store.commitReconcile({
          change: { deletedIds: [parent.id], inserted: [], updated: [] },
          lastReconciledAt: new Date(5000),
          workspaceId: workspace.id,
        })
      ).toMatchObject({ kind: "conflict" });
      expect(await store.listEntries(workspace.id)).toEqual([parent, file]);
    });

    test("creates a Workspace and its complete initial catalog together", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      const nested = fileRecord(workspace.id, {
        name: "guide.md",
        path: "docs/guide.md",
      });

      const docs = directoryRecord(workspace.id, "docs");
      expect(
        await store.commitCreate({
          entries: [readme, docs, nested],
          workspace,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.listEntries(workspace.id)).toEqual([
        readme,
        docs,
        nested,
      ]);
      expect(await store.countFiles(workspace.id)).toBe(2);
      expect(await store.getEntry(workspace.id, readme.id)).toEqual(readme);
    });

    test("finds a Workspace by its canonical root and lists every Workspace", async () => {
      const { store } = await createHarness();
      const first = hostWorkspace({
        createdAt: new Date(1000),
        path: newRoot("alpha"),
      });
      const second = hostWorkspace({
        createdAt: new Date(2000),
        path: newRoot("beta"),
      });
      await store.commitCreate({ entries: [], workspace: first });
      await store.commitCreate({ entries: [], workspace: second });

      expect(await store.findWorkspaceByPath(second.path)).toEqual(second);
      expect(await store.findWorkspaceByPath(newRoot("absent"))).toBeNull();

      const listed = (await store.listWorkspaces()).map((w) => w.id);
      expect(
        listed.filter((id) => id === first.id || id === second.id)
      ).toEqual([first.id, second.id]);
    });

    test("refuses a second Workspace over the same root and names the first", async () => {
      const { store } = await createHarness();
      const root = newRoot("alpha");
      const first = hostWorkspace({ path: root });
      await store.commitCreate({ entries: [], workspace: first });

      expect(
        await store.commitCreate({
          entries: [],
          workspace: hostWorkspace({ path: root }),
        })
      ).toEqual({ existingId: first.id, kind: "workspace-exists" });
      expect(
        (await store.listWorkspaces()).filter((w) => w.path === root)
      ).toEqual([first]);
    });

    test("scopes File paths and lookup to the owning Workspace", async () => {
      const { store } = await createHarness();
      const first = hostWorkspace({ path: newRoot("alpha") });
      const second = hostWorkspace({ path: newRoot("beta") });
      const firstReadme = fileRecord(first.id, { path: "README.md" });
      const secondReadme = fileRecord(second.id, { path: "README.md" });
      await store.commitCreate({
        entries: [firstReadme],
        workspace: first,
      });
      await store.commitCreate({
        entries: [secondReadme],
        workspace: second,
      });

      expect(await store.getEntry(first.id, firstReadme.id)).toEqual(
        firstReadme
      );
      expect(await store.getEntry(first.id, secondReadme.id)).toBeNull();
      expect(await store.listEntries(second.id)).toEqual([secondReadme]);
    });

    test("applies one reconciliation as a whole", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "README.md" });
      const removed = fileRecord(workspace.id, { path: "old.md" });
      await store.commitCreate({
        entries: [kept, removed],
        workspace,
      });

      const edited: WorkspaceFile = {
        ...kept,
        bytes: 12,
        digest:
          "1fb9f4097256db2d7b1e13aff79cee44339891a31c556b9cf6093885773b3618",
        updatedAt: new Date(5000),
      };
      const added = fileRecord(workspace.id, { path: "src/new.ts" });
      const src = directoryRecord(workspace.id, "src");

      expect(
        await store.commitReconcile({
          change: {
            deletedIds: [removed.id],
            inserted: [src, added],
            updated: [edited],
          },
          lastReconciledAt: new Date(5000),
          updatedAt: new Date(5000),
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.listEntries(workspace.id)).toEqual([
        edited,
        src,
        added,
      ]);
      expect((await store.getWorkspace(workspace.id))?.updatedAt).toEqual(
        new Date(5000)
      );
    });

    test("advances freshness strictly when stale callers propose the same observation time", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("freshness") });
      await store.commitCreate({ entries: [], workspace });
      const input = {
        change: { deletedIds: [], inserted: [], updated: [] },
        lastReconciledAt: new Date(1001),
        updatedAt: new Date(1001),
        workspaceId: workspace.id,
      };

      await expect(store.commitReconcile(input)).resolves.toEqual({
        kind: "committed",
      });
      const first = await store.getWorkspace(workspace.id);
      await expect(store.commitReconcile(input)).resolves.toEqual({
        kind: "committed",
      });
      const second = await store.getWorkspace(workspace.id);

      expect(first?.lastReconciledAt.getTime()).toBeGreaterThan(
        workspace.lastReconciledAt.getTime()
      );
      expect(second?.lastReconciledAt.getTime()).toBeGreaterThan(
        first?.lastReconciledAt.getTime() ?? 0
      );
    });

    test("moves one File onto a path the same commit frees", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const target = fileRecord(workspace.id, { path: "README.md" });
      const traveller = fileRecord(workspace.id, { path: "docs/README.md" });
      const docs = directoryRecord(workspace.id, "docs");
      await store.commitCreate({
        entries: [target, docs, traveller],
        workspace,
      });

      // A defensive contract test: `diffCatalog` cannot emit this shape,
      // because a candidate standing at an existing row's path matches that
      // row rather than arriving. It is pinned anyway so the store stays free
      // of an ordering assumption a later producer would have to know about.
      // The unique `(workspaceId, path)` pair only has to hold at the end of
      // the commit, so deletion has to come first in both stores.
      const arrived: WorkspaceFile = {
        ...traveller,
        path: "README.md",
        updatedAt: new Date(6000),
      };

      expect(
        await store.commitReconcile({
          change: {
            deletedIds: [target.id],
            inserted: [],
            updated: [arrived],
          },
          lastReconciledAt: new Date(6000),
          updatedAt: new Date(6000),
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.listEntries(workspace.id)).toEqual([arrived, docs]);
    });

    test("preserves the prior catalog exactly when a commit is rejected", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      await store.commitCreate({ entries: [readme], workspace });
      const before = await store.getWorkspace(workspace.id);

      const collides = fileRecord(workspace.id, { path: "README.md" });
      const result = await store.commitReconcile({
        change: { deletedIds: [], inserted: [collides], updated: [] },
        lastReconciledAt: new Date(9000),
        updatedAt: new Date(9000),
        workspaceId: workspace.id,
      });

      expect(result.kind).toBe("conflict");
      expect(await store.listEntries(workspace.id)).toEqual([readme]);
      expect(await store.getWorkspace(workspace.id)).toEqual(before);
    });

    test("rolls back a reconciliation that breaks partway through", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "README.md" });
      const doomed = fileRecord(workspace.id, { path: "old.md" });
      await store.commitCreate({ entries: [kept, doomed], workspace });
      const before = await store.getWorkspace(workspace.id);

      // Two arrivals claiming one path. The commit gets far enough to have
      // applied a delete and an update before the collision, so a store that
      // did not roll the whole thing back would leave a catalog belonging to
      // no single observation.
      const result = await store.commitReconcile({
        change: {
          deletedIds: [doomed.id],
          inserted: [
            fileRecord(workspace.id, { path: "added.md" }),
            fileRecord(workspace.id, { path: "added.md" }),
          ],
          updated: [
            {
              ...kept,
              digest:
                "1fb9f4097256db2d7b1e13aff79cee44339891a31c556b9cf6093885773b3618",
              updatedAt: new Date(9000),
            },
          ],
        },
        lastReconciledAt: new Date(9000),
        updatedAt: new Date(9000),
        workspaceId: workspace.id,
      });

      expect(result.kind).toBe("conflict");
      expect(await store.listEntries(workspace.id)).toEqual([kept, doomed]);
      expect(await store.getWorkspace(workspace.id)).toEqual(before);
    });

    test("treats deleting an absent or foreign File as already done", async () => {
      const { store } = await createHarness();
      const mine = hostWorkspace({ path: newRoot("alpha") });
      const theirs = hostWorkspace({ path: newRoot("beta") });
      const kept = fileRecord(mine.id, { path: "README.md" });
      const foreign = fileRecord(theirs.id, { path: "README.md" });
      await store.commitCreate({ entries: [kept], workspace: mine });
      await store.commitCreate({ entries: [foreign], workspace: theirs });

      // `delete ... where workspace_id = ? and id in (...)` matches neither an
      // id that is gone nor one belonging to someone else, and reports no
      // failure for either. The end state the caller asked for already holds,
      // so the in-memory reference must not turn that into a conflict.
      expect(
        await store.commitReconcile({
          change: {
            deletedIds: [newWorkspaceEntryId(), foreign.id],
            inserted: [],
            updated: [],
          },
          lastReconciledAt: new Date(7000),
          updatedAt: new Date(7000),
          workspaceId: mine.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.listEntries(mine.id)).toEqual([kept]);
      expect(await store.listEntries(theirs.id)).toEqual([foreign]);
    });

    test("never updates a File another Workspace owns", async () => {
      const { store } = await createHarness();
      const mine = hostWorkspace({ path: newRoot("alpha") });
      const theirs = hostWorkspace({ path: newRoot("beta") });
      const foreign = fileRecord(theirs.id, { path: "README.md" });
      await store.commitCreate({ entries: [], workspace: mine });
      await store.commitCreate({ entries: [foreign], workspace: theirs });

      // The record claims this Workspace, but the row it names is someone
      // else's. `update ... where workspace_id = ? and id = ?` matches nothing,
      // so the durable store leaves it alone — and so must the reference, which
      // would otherwise reassign a live row across an ownership boundary.
      await store.commitReconcile({
        change: {
          deletedIds: [],
          inserted: [],
          updated: [
            {
              ...foreign,
              digest:
                "823d95a9a728f14d626df9a894705dda27417b8927412364255b515e9f2ac2e2",
              workspaceId: mine.id,
            },
          ],
        },
        lastReconciledAt: new Date(8500),
        updatedAt: new Date(8500),
        workspaceId: mine.id,
      });

      expect(await store.listEntries(theirs.id)).toEqual([foreign]);
      expect(await store.listEntries(mine.id)).toEqual([]);
    });

    test("does not resurrect a File that vanished before the commit", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "README.md" });
      const vanished = fileRecord(workspace.id, { path: "gone.md" });
      await store.commitCreate({ entries: [kept], workspace });

      // An update for a row that is no longer there. `update ... where id = ?`
      // matches nothing; a store that wrote the record back instead would
      // recreate a File the catalog had already let go.
      expect(
        await store.commitReconcile({
          change: {
            deletedIds: [],
            inserted: [],
            updated: [
              {
                ...vanished,
                digest:
                  "1fb9f4097256db2d7b1e13aff79cee44339891a31c556b9cf6093885773b3618",
              },
            ],
          },
          lastReconciledAt: new Date(8000),
          updatedAt: new Date(8000),
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.listEntries(workspace.id)).toEqual([kept]);
    });

    test("lets an arrival take the path of an update that matches no row", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const vanished = fileRecord(workspace.id, { path: "notes.md" });
      const arriving = fileRecord(workspace.id, { path: "notes.md" });
      await store.commitCreate({ entries: [], workspace });

      // The update names a row that is gone, so it writes nothing and holds no
      // path. A pre-check that reserved `notes.md` for it anyway would reject
      // an insert the durable store commits without complaint.
      expect(
        await store.commitReconcile({
          change: {
            deletedIds: [],
            inserted: [arriving],
            updated: [vanished],
          },
          lastReconciledAt: new Date(8800),
          updatedAt: new Date(8800),
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.listEntries(workspace.id)).toEqual([arriving]);
    });

    test("reports a reconciliation against an absent Workspace", async () => {
      const { store } = await createHarness();
      const absent = newWorkspaceId();

      expect(
        await store.commitReconcile({
          change: { deletedIds: [], inserted: [], updated: [] },
          lastReconciledAt: new Date(1000),
          updatedAt: new Date(1000),
          workspaceId: absent,
        })
      ).toEqual({ kind: "workspace-not-found" });
      expect(await store.getWorkspace(absent)).toBeNull();
    });

    test("removes one Workspace with its own Files and nothing else", async () => {
      const { store } = await createHarness();
      const first = hostWorkspace({ path: newRoot("alpha") });
      const second = hostWorkspace({ path: newRoot("beta") });
      const firstReadme = fileRecord(first.id, { path: "README.md" });
      const secondReadme = fileRecord(second.id, { path: "README.md" });
      await store.commitCreate({
        entries: [firstReadme],
        workspace: first,
      });
      await store.commitCreate({
        entries: [secondReadme],
        workspace: second,
      });

      expect(await store.removeWorkspace(first.id)).toEqual({
        kind: "removed",
      });

      expect(await store.getWorkspace(first.id)).toBeNull();
      expect(await store.listEntries(first.id)).toEqual([]);
      expect(await store.getEntry(first.id, firstReadme.id)).toBeNull();
      expect(await store.listEntries(second.id)).toEqual([secondReadme]);
      expect(await store.removeWorkspace(first.id)).toEqual({
        kind: "not-found",
      });
    });

    test("refuses a second Workspace over the same source reference", async () => {
      const { store } = await createHarness();
      const artifactId = crypto.randomUUID();
      const first = artifactWorkspace(artifactId, newRoot("first"));
      await store.commitCreate({ entries: [], workspace: first });

      // Distinct roots, one Artifact. SQLite has a unique index for this; the
      // in-memory reference has to reach the same answer or the two stores
      // disagree the moment a second source kind exists.
      expect(
        await store.commitCreate({
          entries: [],
          workspace: artifactWorkspace(artifactId, newRoot("second")),
        })
      ).toEqual({ existingId: first.id, kind: "workspace-exists" });
    });

    test("resolves a candidate that collides on both rules to the root's owner", async () => {
      const { store } = await createHarness();
      const sharedSourceId = crypto.randomUUID();
      const contestedRoot = newRoot("contested");
      const byReference = artifactWorkspace(sharedSourceId, newRoot("first"));
      const byRoot = artifactWorkspace(crypto.randomUUID(), contestedRoot);
      await store.commitCreate({ entries: [], workspace: byReference });
      await store.commitCreate({ entries: [], workspace: byRoot });

      // The candidate collides with one incumbent on its root and a different
      // one on its source reference. `existingId` is what a duplicate add
      // resolves to, so the two stores have to name the same Workspace — the
      // root's owner — rather than whichever predicate each happens to test
      // first.
      expect(
        await store.commitCreate({
          entries: [],
          workspace: artifactWorkspace(sharedSourceId, contestedRoot),
        })
      ).toEqual({ existingId: byRoot.id, kind: "workspace-exists" });
    });

    test("commits one File's post-write observation atomically", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("written") });
      const file = fileRecord(workspace.id, { path: "notes.md" });
      const sibling = fileRecord(workspace.id, { path: "other.md" });
      await store.commitCreate({ entries: [file, sibling], workspace });
      const updatedAt = new Date(file.updatedAt.getTime() + 5000);

      expect(
        await store.commitFileObservation({
          fileId: file.id,
          observed: {
            bytes: 42,
            digest:
              "552b19b9d3e9f6d990ed22f23005713d830372af6b5f1f542d0a1940a5bcd0cc",
            extension: file.extension,
            kind: file.kind,
            mime: file.mime,
            name: file.name,
            path: file.path,
            type: "file" as const,
          },
          updatedAt,
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.getEntry(workspace.id, file.id)).toEqual({
        ...file,
        bytes: 42,
        digest:
          "552b19b9d3e9f6d990ed22f23005713d830372af6b5f1f542d0a1940a5bcd0cc",
        updatedAt,
      });
      // The sibling row and the observation clock are untouched; only the
      // Workspace's own updatedAt moves with its changed catalog fact.
      expect(await store.getEntry(workspace.id, sibling.id)).toEqual(sibling);
      const after = await store.getWorkspace(workspace.id);
      expect(after?.updatedAt).toEqual(updatedAt);
      expect(after?.lastReconciledAt).toEqual(workspace.lastReconciledAt);
    });

    test("refuses a File observation it cannot attach to an existing row", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("refusals") });
      const file = fileRecord(workspace.id, { path: "kept.md" });
      await store.commitCreate({ entries: [file], workspace });
      const observed = {
        bytes: 1,
        digest:
          "11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437",
        extension: file.extension,
        kind: file.kind,
        mime: file.mime,
        name: file.name,
        path: file.path,
        type: "file" as const,
      };
      const updatedAt = new Date(9000);

      expect(
        await store.commitFileObservation({
          fileId: file.id,
          observed,
          updatedAt,
          workspaceId: newWorkspaceId(),
        })
      ).toEqual({ kind: "workspace-not-found" });
      expect(
        await store.commitFileObservation({
          fileId: newWorkspaceEntryId(),
          observed,
          updatedAt,
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "file-not-found" });
      expect(
        await store.commitFileObservation({
          fileId: file.id,
          observed: { ...observed, path: "moved.md" },
          updatedAt,
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "path-mismatch" });

      // Every refusal wrote nothing: no replacement row, no fact change.
      expect(await store.listEntries(workspace.id)).toEqual([file]);
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
    });

    test("never hands a File observation to another Workspace's row", async () => {
      const { store } = await createHarness();
      const owner = hostWorkspace({ path: newRoot("owner") });
      const other = hostWorkspace({ path: newRoot("other") });
      const theirs = fileRecord(other.id, { path: "shared.md" });
      await store.commitCreate({ entries: [], workspace: owner });
      await store.commitCreate({ entries: [theirs], workspace: other });

      expect(
        await store.commitFileObservation({
          fileId: theirs.id,
          observed: {
            bytes: 1,
            digest:
              "823d95a9a728f14d626df9a894705dda27417b8927412364255b515e9f2ac2e2",
            extension: theirs.extension,
            kind: theirs.kind,
            mime: theirs.mime,
            name: theirs.name,
            path: theirs.path,
            type: "file" as const,
          },
          updatedAt: new Date(9000),
          workspaceId: owner.id,
        })
      ).toEqual({ kind: "file-not-found" });
      expect(await store.getEntry(other.id, theirs.id)).toEqual(theirs);
    });

    describe("public operations", () => {
      const sources: string[] = [];

      afterAll(async () => {
        await Promise.all(
          sources.map((root) => rm(root, { force: true, recursive: true }))
        );
      });

      async function sourceDirectory(
        tree: Record<string, string>
      ): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), "foundry-workspace-suite-"));
        sources.push(root);
        for (const [relativePath, contents] of Object.entries(tree)) {
          const absolute = join(root, relativePath);
          await mkdir(join(absolute, ".."), { recursive: true });
          await writeFile(absolute, contents);
        }
        return root;
      }

      test("publishes committed entry changes and preserves deleted descriptors", async () => {
        const { system, store } = await createHarness();
        const events: WorkspaceChange[] = [];
        const stop = system.on("change", (change) => {
          events.push(change);
        });
        const root = await sourceDirectory({
          "keep.txt": "first",
          "move.txt": "unique",
        });
        await mkdir(join(root, "empty"));
        await symlink("missing", join(root, "link"));
        const workspace = await system.add({ path: root });
        const initial = await workspace.entries();
        expect(events).toEqual(
          initial.map((entry) => ({ action: "add", entry }))
        );
        events.length = 0;
        await system.add({ path: root });
        await workspace.refresh();
        expect(events).toEqual([]);

        await writeFile(join(root, "keep.txt"), "second");
        await rename(join(root, "move.txt"), join(root, "moved.txt"));
        await rm(join(root, "link"));
        await workspace.refresh();
        const current = await workspace.entries();
        expect(events).toEqual([
          {
            action: "delete",
            entry: initial.find((entry) => entry.path === "link"),
          },
          {
            action: "change",
            entry: current.find((entry) => entry.path === "keep.txt"),
          },
          {
            action: "change",
            entry: current.find((entry) => entry.path === "moved.txt"),
          },
        ]);
        expect(events[2]?.entry.id).toBe(
          initial.find((entry) => entry.path === "move.txt")?.id
        );
        expect(await store.listEntries(workspace.id)).toEqual(current);
        events.length = 0;
        await workspace.remove();
        expect(events).toEqual(
          current.map((entry) => ({ action: "delete", entry }))
        );
        stop();
      });

      test("save publishes once and no-op, conflict, and failed scans publish nothing", async () => {
        const { system } = await createHarness();
        const root = await sourceDirectory({ "file.txt": "first" });
        const workspace = await system.add({ path: root });
        const [file] = await workspace.files();
        if (!file) {
          throw new Error("Expected file");
        }
        const events: WorkspaceChange[] = [];
        const stop = system.on("change", (change) => {
          events.push(change);
        });
        const result = await workspace.save({
          expectedDigest: file.digest,
          fileId: file.id,
          text: "second",
        });
        expect(result.kind).toBe("saved");
        const [saved] = await workspace.files();
        if (!saved) {
          throw new Error("Expected saved file");
        }
        expect(events).toEqual([{ action: "change", entry: saved }]);
        events.length = 0;
        await workspace.refresh();
        await workspace.save({
          expectedDigest: saved.digest,
          fileId: saved.id,
          text: "second",
        });
        expect(
          (
            await workspace.save({
              expectedDigest: file.digest,
              fileId: saved.id,
              text: "third",
            })
          ).kind
        ).toBe("conflict");
        await rm(root, { force: true, recursive: true });
        expect((await workspace.refresh()).source.kind).toBe("unavailable");
        expect(events).toEqual([]);
        stop();
      });

      test("removal waits for a save and deletes its committed descriptor", async () => {
        const { system, store } = await createHarness();
        const root = await sourceDirectory({ "file.txt": "first" });
        const workspace = await system.add({ path: root });
        const [file] = await workspace.files();
        if (!file) {
          throw new Error("Expected file");
        }
        const events: WorkspaceChange[] = [];
        const stop = system.on("change", (change) => {
          events.push(change);
        });
        const started = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const commit = store.commitFileObservation.bind(store);
        const observation = vi
          .spyOn(store, "commitFileObservation")
          .mockImplementation(async (input) => {
            started.resolve(undefined);
            await release.promise;
            return commit(input);
          });
        try {
          const save = workspace.save({
            expectedDigest: file.digest,
            fileId: file.id,
            text: "second",
          });
          await started.promise;
          const removal = workspace.remove();
          release.resolve(undefined);
          await Promise.all([save, removal]);
          expect(events.map((event) => event.action)).toEqual([
            "change",
            "delete",
          ]);
          expect(events[1]?.entry).toEqual(events[0]?.entry);
        } finally {
          release.resolve(undefined);
          observation.mockRestore();
          stop();
        }
      });

      test("unsubscribe stops future notifications", async () => {
        const { system } = await createHarness();
        const events: WorkspaceChange[] = [];
        const stop = system.on("change", (change) => {
          events.push(change);
        });
        stop();
        await system.add({
          path: await sourceDirectory({ "file.txt": "one" }),
        });
        expect(events).toEqual([]);
      });

      test("waits for reconciliation when a saved file's catalog update fails", async () => {
        const { system, store } = await createHarness();
        const root = await sourceDirectory({ "file.txt": "first" });
        const workspace = await system.add({ path: root });
        const [file] = await workspace.files();
        if (!file) {
          throw new Error("Expected file");
        }
        const events: WorkspaceChange[] = [];
        const stop = system.on("change", (change) => {
          events.push(change);
        });
        const observation = vi
          .spyOn(store, "commitFileObservation")
          .mockRejectedValueOnce(new Error("unavailable"));
        try {
          expect(
            await workspace.save({
              expectedDigest: file.digest,
              fileId: file.id,
              text: "second",
            })
          ).toMatchObject({ catalog: "refresh-required", kind: "saved" });
          expect(events).toEqual([]);
          await workspace.refresh();
          expect(events).toEqual([
            { action: "change", entry: (await workspace.files())[0] },
          ]);
        } finally {
          observation.mockRestore();
          stop();
        }
      });

      test("adds a directory and catalogs every included File", async () => {
        const { system } = await createHarness();
        const root = await sourceDirectory({
          "README.md": "hello",
          "src/deep/app.ts": "const a = 1;\n",
        });

        const added = await system.add({ path: root });

        expect(await added.summary()).toMatchObject({
          fileCount: 2,
          sourceKind: "host",
        });
        expect((await added.files()).map((f) => f.path)).toEqual([
          "README.md",
          "src/deep/app.ts",
        ]);
        expect(await (await system.open(added.id)).summary()).toEqual(
          await added.summary()
        );
        expect((await system.list()).map((w) => w.id)).toContain(added.id);
      });

      test("resolves a duplicate add to the Workspace already registered", async () => {
        const { system } = await createHarness();
        const root = await sourceDirectory({ "README.md": "hello" });

        const first = await system.add({ path: root });

        expect((await system.add({ path: root })).id).toBe(first.id);
        expect(
          (await system.list()).filter((w) => w.id === first.id)
        ).toHaveLength(1);
      });

      test("reconciles edits, arrivals, a unique move, and departures", async () => {
        const { system } = await createHarness();
        const root = await sourceDirectory({
          "drop.md": "temporary",
          "README.md": "first",
          "src/notes.md": "one of a kind",
        });
        const added = await system.add({ path: root });
        const before = await added.files();
        const moved = before.find((file) => file.path === "src/notes.md");
        const edited = before.find((file) => file.path === "README.md");

        await writeFile(join(root, "README.md"), "second");
        await rm(join(root, "drop.md"));
        await mkdir(join(root, "docs"), { recursive: true });
        await rm(join(root, "src", "notes.md"));
        await writeFile(join(root, "docs", "notes.md"), "one of a kind");
        await writeFile(join(root, "added.md"), "new");

        const view = await added.refresh();

        expect(view.source).toEqual({ kind: "reconciled" });
        expect(
          view.entries
            .filter((entry) => entry.type === "file")
            .map((file) => file.path)
        ).toEqual(["README.md", "added.md", "docs/notes.md"]);
        expect(
          view.entries.find((file) => file.path === "docs/notes.md")?.id
        ).toBe(moved?.id);
        expect(view.entries.find((file) => file.path === "README.md")?.id).toBe(
          edited?.id
        );
        expect(await added.entries()).toEqual(view.entries);
      });

      test("returns the prior catalog beside an unavailable source", async () => {
        const { system } = await createHarness();
        const root = await sourceDirectory({ "README.md": "hello" });
        const added = await system.add({ path: root });
        const before = await added.files();

        await rm(root, { force: true, recursive: true });
        const view = await added.refresh();

        expect(view.source).toMatchObject({ kind: "unavailable" });
        expect(view.entries).toEqual(before);
        expect(await added.summary()).toBeTruthy();
      });

      test("removes a Workspace and its Files without touching the source", async () => {
        const { system, store } = await createHarness();
        const root = await sourceDirectory({
          "README.md": "hello",
          "src/app.ts": "1",
        });
        const added = await system.add({ path: root });

        await added.remove();

        expect(await store.getWorkspace(added.id)).toBeNull();
        expect(await store.listEntries(added.id)).toEqual([]);
        expect(await readFile(join(root, "README.md"), "utf8")).toBe("hello");
        expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe("1");
      });

      test("reads the source's current text, not the catalogued facts", async () => {
        const { system } = await createHarness();
        const root = await sourceDirectory({ "README.md": "first" });
        const added = await system.add({ path: root });
        const [file] = await added.files();
        if (!file) {
          throw new Error("expected one File");
        }

        await writeFile(join(root, "README.md"), "second");

        expect(await added.read(file.id)).toEqual({
          bytes: 6,
          // Computed from the bytes just read — deliberately not the
          // catalogued digest, which still describes "first".
          digest: sha256Hex(new TextEncoder().encode("second")),
          kind: "text",
          mime: "text/markdown",
          text: "second",
          type: "file" as const,
        });
        expect((await added.files())[0]).toEqual(file);
      });

      test("saves a host File and converges catalog, source, and version", async () => {
        const { system, store } = await createHarness();
        const root = await sourceDirectory({ "notes.md": "before" });
        const added = await system.add({ path: root });
        const [file] = await added.files();
        if (!file) {
          throw new Error("expected one File");
        }
        const read = await added.read(file.id);
        if (read.kind !== "text") {
          throw new Error("expected a text read");
        }

        const result = await added.save({
          expectedDigest: read.digest,
          fileId: file.id,
          text: "after the save",
        });

        if (result.kind !== "saved") {
          throw new Error("expected saved");
        }
        expect(result.catalog).toBe("current");
        expect(await readFile(join(root, "notes.md"), "utf8")).toBe(
          "after the save"
        );
        expect(await added.read(file.id)).toMatchObject({
          digest: result.snapshot.digest,
          kind: "text",
          text: "after the save",
        });
        const [row] = await store.listEntries(added.id);
        expect(row).toMatchObject({
          bytes: result.snapshot.bytes,
          digest: result.snapshot.digest,
          id: file.id,
        });
      });

      test("returns a conflict with the current snapshot and leaves the source unchanged", async () => {
        const { system } = await createHarness();
        const root = await sourceDirectory({ "notes.md": "mine" });
        const added = await system.add({ path: root });
        const [file] = await added.files();
        if (!file) {
          throw new Error("expected one File");
        }

        await writeFile(join(root, "notes.md"), "theirs");

        const result = await added.save({
          expectedDigest: file.digest,
          fileId: file.id,
          text: "my draft",
        });

        expect(result).toMatchObject({
          current: { text: "theirs" },
          kind: "conflict",
        });
        expect(await readFile(join(root, "notes.md"), "utf8")).toBe("theirs");
      });
    });
  });
}

/**
 * A floor for `source` that observes nothing. The store-level cases write
 * `artifact` rows to prove uniqueness rules; over a shared store those rows
 * must still be listable, and the system refuses to open a source no layer
 * claims.
 */
export function emptyLayer(source: string): WorkspaceExtension {
  return {
    applies: (record) => record.source === source,
    name: source,
    wrap: (Base) =>
      class extends Base {
        scan() {
          return Promise.resolve([]);
        }
      },
  };
}

/**
 * A canonical root no other case in this suite can collide with. Workspace
 * roots are globally unique, so a durable store running every case against one
 * database needs a fresh root per case rather than a shared literal.
 */
export function newRoot(label: string): string {
  return `/src/${crypto.randomUUID()}/${label}`;
}

export function newWorkspaceId(): WorkspaceId {
  return crypto.randomUUID() as WorkspaceId;
}

export function newWorkspaceEntryId(): WorkspaceEntryId {
  return crypto.randomUUID() as WorkspaceEntryId;
}

export function hostWorkspace(
  overrides: Partial<StoredWorkspaceRecord> & { path: string }
): StoredWorkspaceRecord {
  const createdAt = overrides.createdAt ?? new Date(1000);
  return {
    createdAt,
    description: null,
    documentation: null,
    id: newWorkspaceId(),
    lastReconciledAt: overrides.lastReconciledAt ?? createdAt,
    name: "alpha",
    source: "host",
    sourceId: null,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  };
}

export function directoryRecord(
  workspaceId: WorkspaceId,
  path: string
): WorkspaceEntry {
  return {
    createdAt: new Date(1000),
    id: newWorkspaceEntryId(),
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type: "directory",
    updatedAt: new Date(1000),
    workspaceId,
  };
}

/**
 * Both stores must agree on uniqueness for every source kind, even while the
 * common fixtures leave `sourceId` null.
 */
export function artifactWorkspace(
  artifactId: string,
  path: string
): StoredWorkspaceRecord {
  return hostWorkspace({ path, source: "artifact", sourceId: artifactId });
}

export function fileRecord(
  workspaceId: WorkspaceId,
  overrides: Partial<WorkspaceFile> & { path: string }
): WorkspaceFile {
  const createdAt = overrides.createdAt ?? new Date(1000);
  return {
    bytes: 4,
    createdAt,
    digest: "0bf474896363505e5ea5e5d6ace8ebfb13a760a409b1fb467d428fc716f9f284",
    extension: "md",
    id: newWorkspaceEntryId(),
    kind: "document",
    mime: "text/markdown",
    name: overrides.path.split("/").at(-1) ?? overrides.path,
    type: "file",
    updatedAt: overrides.updatedAt ?? createdAt,
    workspaceId,
    ...overrides,
  };
}
