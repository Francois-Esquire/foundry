import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import type { DirectoryRef } from "../../directory";
import type {
  AnyWorkspaceExtension,
  WorkspaceExtension,
} from "../../extension";
import { sha256Hex } from "../../filesystem";
import type { WorkspaceFileId, WorkspaceId } from "../../workspace";
import type {
  StoredFileRecord,
  StoredWorkspaceRecord,
  WorkspaceStore,
} from "../../workspace-store";
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
    test("creates a Workspace and its complete initial catalog together", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      const nested = fileRecord(workspace.id, {
        name: "guide.md",
        path: "docs/guide.md",
      });

      expect(
        await store.commitCreate({
          files: [readme, nested],
          workspace,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.listFiles(workspace.id)).toEqual([readme, nested]);
      expect(await store.countFiles(workspace.id)).toBe(2);
      expect(await store.getFile(workspace.id, readme.id)).toEqual(readme);
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
      await store.commitCreate({ files: [], workspace: first });
      await store.commitCreate({ files: [], workspace: second });

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
      await store.commitCreate({ files: [], workspace: first });

      expect(
        await store.commitCreate({
          files: [],
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
        files: [firstReadme],
        workspace: first,
      });
      await store.commitCreate({
        files: [secondReadme],
        workspace: second,
      });

      expect(await store.getFile(first.id, firstReadme.id)).toEqual(
        firstReadme
      );
      expect(await store.getFile(first.id, secondReadme.id)).toBeNull();
      expect(await store.listFiles(second.id)).toEqual([secondReadme]);
    });

    test("applies one reconciliation as a whole", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "README.md" });
      const removed = fileRecord(workspace.id, { path: "old.md" });
      await store.commitCreate({
        files: [kept, removed],
        workspace,
      });

      const edited: StoredFileRecord = {
        ...kept,
        checksum: "edited",
        size: 12,
        updatedAt: new Date(5000),
      };
      const added = fileRecord(workspace.id, { path: "src/new.ts" });

      expect(
        await store.commitReconcile({
          change: {
            deletedIds: [removed.id],
            inserted: [added],
            updated: [edited],
          },
          lastReconciledAt: new Date(5000),
          updatedAt: new Date(5000),
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.listFiles(workspace.id)).toEqual([edited, added]);
      expect((await store.getWorkspace(workspace.id))?.updatedAt).toEqual(
        new Date(5000)
      );
    });

    test("advances freshness strictly when stale callers propose the same observation time", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("freshness") });
      await store.commitCreate({ files: [], workspace });
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
      await store.commitCreate({
        files: [target, traveller],
        workspace,
      });

      // A defensive contract test: `diffCatalog` cannot emit this shape,
      // because a candidate standing at an existing row's path matches that
      // row rather than arriving. It is pinned anyway so the store stays free
      // of an ordering assumption a later producer would have to know about.
      // The unique `(workspaceId, path)` pair only has to hold at the end of
      // the commit, so deletion has to come first in both stores.
      const arrived: StoredFileRecord = {
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

      expect(await store.listFiles(workspace.id)).toEqual([arrived]);
    });

    test("preserves the prior catalog exactly when a commit is rejected", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      await store.commitCreate({ files: [readme], workspace });
      const before = await store.getWorkspace(workspace.id);

      const collides = fileRecord(workspace.id, { path: "README.md" });
      const result = await store.commitReconcile({
        change: { deletedIds: [], inserted: [collides], updated: [] },
        lastReconciledAt: new Date(9000),
        updatedAt: new Date(9000),
        workspaceId: workspace.id,
      });

      expect(result.kind).toBe("conflict");
      expect(await store.listFiles(workspace.id)).toEqual([readme]);
      expect(await store.getWorkspace(workspace.id)).toEqual(before);
    });

    test("rolls back a reconciliation that breaks partway through", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "README.md" });
      const doomed = fileRecord(workspace.id, { path: "old.md" });
      await store.commitCreate({ files: [kept, doomed], workspace });
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
          updated: [{ ...kept, checksum: "edited", updatedAt: new Date(9000) }],
        },
        lastReconciledAt: new Date(9000),
        updatedAt: new Date(9000),
        workspaceId: workspace.id,
      });

      expect(result.kind).toBe("conflict");
      expect(await store.listFiles(workspace.id)).toEqual([kept, doomed]);
      expect(await store.getWorkspace(workspace.id)).toEqual(before);
    });

    test("treats deleting an absent or foreign File as already done", async () => {
      const { store } = await createHarness();
      const mine = hostWorkspace({ path: newRoot("alpha") });
      const theirs = hostWorkspace({ path: newRoot("beta") });
      const kept = fileRecord(mine.id, { path: "README.md" });
      const foreign = fileRecord(theirs.id, { path: "README.md" });
      await store.commitCreate({ files: [kept], workspace: mine });
      await store.commitCreate({ files: [foreign], workspace: theirs });

      // `delete ... where workspace_id = ? and id in (...)` matches neither an
      // id that is gone nor one belonging to someone else, and reports no
      // failure for either. The end state the caller asked for already holds,
      // so the in-memory reference must not turn that into a conflict.
      expect(
        await store.commitReconcile({
          change: {
            deletedIds: [newWorkspaceFileId(), foreign.id],
            inserted: [],
            updated: [],
          },
          lastReconciledAt: new Date(7000),
          updatedAt: new Date(7000),
          workspaceId: mine.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.listFiles(mine.id)).toEqual([kept]);
      expect(await store.listFiles(theirs.id)).toEqual([foreign]);
    });

    test("never updates a File another Workspace owns", async () => {
      const { store } = await createHarness();
      const mine = hostWorkspace({ path: newRoot("alpha") });
      const theirs = hostWorkspace({ path: newRoot("beta") });
      const foreign = fileRecord(theirs.id, { path: "README.md" });
      await store.commitCreate({ files: [], workspace: mine });
      await store.commitCreate({ files: [foreign], workspace: theirs });

      // The record claims this Workspace, but the row it names is someone
      // else's. `update ... where workspace_id = ? and id = ?` matches nothing,
      // so the durable store leaves it alone — and so must the reference, which
      // would otherwise reassign a live row across an ownership boundary.
      await store.commitReconcile({
        change: {
          deletedIds: [],
          inserted: [],
          updated: [{ ...foreign, checksum: "stolen", workspaceId: mine.id }],
        },
        lastReconciledAt: new Date(8500),
        updatedAt: new Date(8500),
        workspaceId: mine.id,
      });

      expect(await store.listFiles(theirs.id)).toEqual([foreign]);
      expect(await store.listFiles(mine.id)).toEqual([]);
    });

    test("does not resurrect a File that vanished before the commit", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "README.md" });
      const vanished = fileRecord(workspace.id, { path: "gone.md" });
      await store.commitCreate({ files: [kept], workspace });

      // An update for a row that is no longer there. `update ... where id = ?`
      // matches nothing; a store that wrote the record back instead would
      // recreate a File the catalog had already let go.
      expect(
        await store.commitReconcile({
          change: {
            deletedIds: [],
            inserted: [],
            updated: [{ ...vanished, checksum: "edited" }],
          },
          lastReconciledAt: new Date(8000),
          updatedAt: new Date(8000),
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.listFiles(workspace.id)).toEqual([kept]);
    });

    test("lets an arrival take the path of an update that matches no row", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const vanished = fileRecord(workspace.id, { path: "notes.md" });
      const arriving = fileRecord(workspace.id, { path: "notes.md" });
      await store.commitCreate({ files: [], workspace });

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

      expect(await store.listFiles(workspace.id)).toEqual([arriving]);
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
        files: [firstReadme],
        workspace: first,
      });
      await store.commitCreate({
        files: [secondReadme],
        workspace: second,
      });

      expect(await store.removeWorkspace(first.id)).toEqual({
        kind: "removed",
      });

      expect(await store.getWorkspace(first.id)).toBeNull();
      expect(await store.listFiles(first.id)).toEqual([]);
      expect(await store.getFile(first.id, firstReadme.id)).toBeNull();
      expect(await store.listFiles(second.id)).toEqual([secondReadme]);
      expect(await store.removeWorkspace(first.id)).toEqual({
        kind: "not-found",
      });
    });

    test("refuses a second Workspace over the same source reference", async () => {
      const { store } = await createHarness();
      const artifactId = crypto.randomUUID();
      const first = artifactWorkspace(artifactId, newRoot("first"));
      await store.commitCreate({ files: [], workspace: first });

      // Distinct roots, one Artifact. SQLite has a unique index for this; the
      // in-memory reference has to reach the same answer or the two stores
      // disagree the moment a second source kind exists.
      expect(
        await store.commitCreate({
          files: [],
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
      await store.commitCreate({ files: [], workspace: byReference });
      await store.commitCreate({ files: [], workspace: byRoot });

      // The candidate collides with one incumbent on its root and a different
      // one on its source reference. `existingId` is what a duplicate add
      // resolves to, so the two stores have to name the same Workspace — the
      // root's owner — rather than whichever predicate each happens to test
      // first.
      expect(
        await store.commitCreate({
          files: [],
          workspace: artifactWorkspace(sharedSourceId, contestedRoot),
        })
      ).toEqual({ existingId: byRoot.id, kind: "workspace-exists" });
    });

    test("commits one File's post-write observation atomically", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("written") });
      const file = fileRecord(workspace.id, { path: "notes.md" });
      const sibling = fileRecord(workspace.id, { path: "other.md" });
      await store.commitCreate({ files: [file, sibling], workspace });
      const updatedAt = new Date(file.updatedAt.getTime() + 5000);

      expect(
        await store.commitFileObservation({
          fileId: file.id,
          observed: {
            checksum: "written-checksum",
            extension: file.extension,
            kind: file.kind,
            mimeType: file.mimeType,
            name: file.name,
            path: file.path,
            size: 42,
          },
          updatedAt,
          workspaceId: workspace.id,
        })
      ).toEqual({ kind: "committed" });

      expect(await store.getFile(workspace.id, file.id)).toEqual({
        ...file,
        checksum: "written-checksum",
        size: 42,
        updatedAt,
      });
      // The sibling row and the observation clock are untouched; only the
      // Workspace's own updatedAt moves with its changed catalog fact.
      expect(await store.getFile(workspace.id, sibling.id)).toEqual(sibling);
      const after = await store.getWorkspace(workspace.id);
      expect(after?.updatedAt).toEqual(updatedAt);
      expect(after?.lastReconciledAt).toEqual(workspace.lastReconciledAt);
    });

    test("refuses a File observation it cannot attach to an existing row", async () => {
      const { store } = await createHarness();
      const workspace = hostWorkspace({ path: newRoot("refusals") });
      const file = fileRecord(workspace.id, { path: "kept.md" });
      await store.commitCreate({ files: [file], workspace });
      const observed = {
        checksum: "new",
        extension: file.extension,
        kind: file.kind,
        mimeType: file.mimeType,
        name: file.name,
        path: file.path,
        size: 1,
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
          fileId: newWorkspaceFileId(),
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
      expect(await store.listFiles(workspace.id)).toEqual([file]);
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
    });

    test("never hands a File observation to another Workspace's row", async () => {
      const { store } = await createHarness();
      const owner = hostWorkspace({ path: newRoot("owner") });
      const other = hostWorkspace({ path: newRoot("other") });
      const theirs = fileRecord(other.id, { path: "shared.md" });
      await store.commitCreate({ files: [], workspace: owner });
      await store.commitCreate({ files: [theirs], workspace: other });

      expect(
        await store.commitFileObservation({
          fileId: theirs.id,
          observed: {
            checksum: "stolen",
            extension: theirs.extension,
            kind: theirs.kind,
            mimeType: theirs.mimeType,
            name: theirs.name,
            path: theirs.path,
            size: 1,
          },
          updatedAt: new Date(9000),
          workspaceId: owner.id,
        })
      ).toEqual({ kind: "file-not-found" });
      expect(await store.getFile(other.id, theirs.id)).toEqual(theirs);
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
        expect(view.files.map((file) => file.path)).toEqual([
          "README.md",
          "added.md",
          "docs/notes.md",
        ]);
        expect(
          view.files.find((file) => file.path === "docs/notes.md")?.id
        ).toBe(moved?.id);
        expect(view.files.find((file) => file.path === "README.md")?.id).toBe(
          edited?.id
        );
        expect(await added.files()).toEqual(view.files);
      });

      test("returns the prior catalog beside an unavailable source", async () => {
        const { system } = await createHarness();
        const root = await sourceDirectory({ "README.md": "hello" });
        const added = await system.add({ path: root });
        const before = await added.files();

        await rm(root, { force: true, recursive: true });
        const view = await added.refresh();

        expect(view.source).toMatchObject({ kind: "unavailable" });
        expect(view.files).toEqual(before);
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
        expect(await store.listFiles(added.id)).toEqual([]);
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
          // Computed from the bytes just read — deliberately not the
          // catalogued checksum, which still describes "first".
          checksum: sha256Hex(new TextEncoder().encode("second")),
          kind: "text",
          mimeType: "text/markdown",
          size: 6,
          text: "second",
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
          expectedChecksum: read.checksum,
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
          checksum: result.snapshot.checksum,
          kind: "text",
          text: "after the save",
        });
        const [row] = await store.listFiles(added.id);
        expect(row).toMatchObject({
          checksum: result.snapshot.checksum,
          id: file.id,
          size: result.snapshot.size,
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
          expectedChecksum: file.checksum,
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

export function newWorkspaceFileId(): WorkspaceFileId {
  return crypto.randomUUID() as WorkspaceFileId;
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

/**
 * The other member of the closed source enumeration. Milestone 1 writes no
 * `artifact` rows, but both stores must already agree on their uniqueness rule
 * — the divergence is invisible while every fixture leaves `sourceId` null.
 */
export function artifactWorkspace(
  artifactId: string,
  path: string
): StoredWorkspaceRecord {
  return hostWorkspace({ path, source: "artifact", sourceId: artifactId });
}

export function fileRecord(
  workspaceId: WorkspaceId,
  overrides: Partial<StoredFileRecord> & { path: string }
): StoredFileRecord {
  const createdAt = overrides.createdAt ?? new Date(1000);
  return {
    checksum: "checksum",
    createdAt,
    extension: "md",
    id: newWorkspaceFileId(),
    kind: "document",
    mimeType: "text/markdown",
    name: overrides.path.split("/").at(-1) ?? overrides.path,
    size: 4,
    updatedAt: overrides.updatedAt ?? createdAt,
    workspaceId,
    ...overrides,
  };
}
