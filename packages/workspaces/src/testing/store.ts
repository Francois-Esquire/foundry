import { describe, expect, test } from "vitest";
import type { WorkspaceStore, WorkspaceStoreWrite } from "../store";
import type {
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceRegistration,
} from "../types";
import {
  artifactWorkspace,
  directoryRecord,
  fileRecord,
  hostWorkspace,
  newRoot,
  newWorkspaceEntryId,
  newWorkspaceId,
  seed,
} from "./records";

/**
 * Fresh, empty storage, reached one scope at a time. The same scope reaches
 * the same records on every call; two scopes never see each other's. A store
 * that has no scopes keeps one store per scope name.
 */
export type ScopedWorkspaceStores = (scope: string) => WorkspaceStore;

/**
 * What every `WorkspaceStore` must do. A store enforces no catalog rule, so
 * these cases pin only persistence: every read, both writes, ordering,
 * scoping by Workspace and by scope, atomic writes, detached values, large
 * writes, and transactions. Each case calls `open` for fresh, empty storage,
 * then opens a store over one scope of it. The host's test file closes
 * whatever `open` opened.
 */
export function describeWorkspaceStore(
  name: string,
  open: () => ScopedWorkspaceStores | Promise<ScopedWorkspaceStores>
): void {
  describe(`${name} WorkspaceStore conformance`, () => {
    describeReads(open);
    describeOrdering(open);
    describeWrites(open);
    describeScopes(open);
    describeAtomicity(open);
    describeDetachment(open);
    describeLargeWrites(open);
    describeTransactions(open);
    describeReentry(open);
  });
}

/** Opens fresh, empty storage, reached one scope at a time. */
type Open = () => ScopedWorkspaceStores | Promise<ScopedWorkspaceStores>;

/** The one scope every case works in. */
const SCOPE = "workspaces";

function describeReads(open: Open): void {
  describe("reads", () => {
    test("answer an empty store with nothing", async () => {
      const store = (await open())(SCOPE);
      const absent = newWorkspaceId();

      expect(await store.getWorkspace(absent)).toBeNull();
      expect(await store.getEntry(absent, newWorkspaceEntryId())).toBeNull();
      expect(await store.listEntries(absent)).toEqual([]);
      expect(await store.findWorkspaceByPath(newRoot("absent"))).toBeNull();
      expect(await store.findWorkspaceBySourceId("absent")).toBeNull();
      expect(await store.listWorkspaces()).toEqual({ items: [], total: 0 });
    });

    test("round-trip a registration and its entries in path order", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const docs = directoryRecord(workspace.id, "docs");
      const readme = fileRecord(workspace.id, { path: "README.md" });
      const guide = fileRecord(workspace.id, { path: "docs/guide.md" });
      const link = {
        ...directoryRecord(workspace.id, "latest"),
        target: "docs/guide.md",
        type: "symlink",
      } as const;
      await seed(store, workspace, [guide, link, docs, readme]);

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.listEntries(workspace.id)).toEqual([
        readme,
        docs,
        guide,
        link,
      ]);
      expect(await store.getEntry(workspace.id, guide.id)).toEqual(guide);
      expect(await store.getEntry(workspace.id, link.id)).toEqual(link);
    });

    test("keep every value as written, at the edges of each field", async () => {
      const store = (await open())(SCOPE);
      const workspace: WorkspaceRegistration = {
        createdAt: new Date(-8.64e15),
        id: newWorkspaceId(),
        lastReconciledAt: new Date(8.64e15),
        name: "\u{1F600} Ａ \t\n",
        source: { kind: "", path: newRoot("edges"), sourceId: "" },
        updatedAt: new Date(0),
      };
      const unnamed = hostWorkspace({ path: newRoot("unnamed") });
      const entries: WorkspaceEntry[] = [
        fileRecord(workspace.id, {
          bytes: 0,
          extension: null,
          mime: null,
          path: "empty",
        }),
        fileRecord(workspace.id, {
          bytes: Number.MAX_SAFE_INTEGER,
          createdAt: new Date(-1),
          extension: "",
          kind: "other",
          mime: "",
          path: "huge.bin",
          updatedAt: new Date(8.64e15),
        }),
        {
          ...directoryRecord(workspace.id, "link"),
          target: "",
          type: "symlink",
        },
        { ...directoryRecord(workspace.id, "socket"), type: "socket" },
        { ...directoryRecord(workspace.id, "device"), type: "device" },
        { ...directoryRecord(workspace.id, "pipe"), type: "pipe" },
      ];
      await seed(store, workspace, entries);
      await seed(store, unnamed);

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.getWorkspace(unnamed.id)).toEqual(unnamed);
      expect(await store.findWorkspaceBySourceId("")).toEqual(workspace);
      expect(await store.listEntries(workspace.id)).toEqual(
        [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))
      );
      for (const entry of entries) {
        expect(await store.getEntry(workspace.id, entry.id)).toEqual(entry);
      }
    });

    test("page within bounds, past the end, and over the largest page", async () => {
      const store = (await open())(SCOPE);
      const created = Array.from({ length: 201 }, (_, index) =>
        hostWorkspace({
          createdAt: new Date(index),
          path: newRoot(String(index)),
        })
      );
      for (const workspace of created) {
        await seed(store, workspace);
      }

      const largest = await store.listWorkspaces({ limit: 1000 });
      expect(largest.items).toEqual(created.slice(0, 200));
      expect(largest.total).toBe(201);
      expect(largest.nextCursor).toBe(200);
      expect(await store.listWorkspaces({ cursor: 200, limit: 5 })).toEqual({
        items: created.slice(200),
        total: 201,
      });
      expect(await store.listWorkspaces({ cursor: 500 })).toEqual({
        items: [],
        total: 201,
      });
      for (const input of [
        { limit: 0 },
        { limit: 1.5 },
        { cursor: -1 },
        { cursor: 1.5 },
      ]) {
        await expect(store.listWorkspaces(input)).rejects.toThrow(RangeError);
      }
    });

    test("scope entries to their Workspace", async () => {
      const store = (await open())(SCOPE);
      const first = hostWorkspace({ path: newRoot("alpha") });
      const second = hostWorkspace({ path: newRoot("beta") });
      const firstReadme = fileRecord(first.id, { path: "README.md" });
      const secondReadme = fileRecord(second.id, { path: "README.md" });
      await seed(store, first, [firstReadme]);
      await seed(store, second, [secondReadme]);

      expect(await store.getEntry(first.id, secondReadme.id)).toBeNull();
      expect(await store.getEntry(second.id, secondReadme.id)).toEqual(
        secondReadme
      );
      expect(await store.listEntries(first.id)).toEqual([firstReadme]);
      expect(await store.listEntries(second.id)).toEqual([secondReadme]);
    });

    test("find the oldest registration by root or source reference", async () => {
      const store = (await open())(SCOPE);
      const artifactId = crypto.randomUUID();
      const older = artifactWorkspace(artifactId, newRoot("older"));
      const newer = {
        ...artifactWorkspace(artifactId, newRoot("newer")),
        createdAt: new Date(2000),
      };
      await seed(store, newer);
      await seed(store, older);

      expect(await store.findWorkspaceByPath(newer.source.path)).toEqual(newer);
      expect(await store.findWorkspaceByPath(older.source.path)).toEqual(older);
      expect(await store.findWorkspaceBySourceId(artifactId)).toEqual(older);
    });

    test("break a creation-time tie by id when finding the oldest", async () => {
      const store = (await open())(SCOPE);
      const root = newRoot("shared");
      const [low, high] = [newWorkspaceId(), newWorkspaceId()].sort();
      const first = hostWorkspace({ id: low, path: root, sourceId: "same" });
      const second = hostWorkspace({ id: high, path: root, sourceId: "same" });
      await seed(store, second);
      await seed(store, first);

      expect(await store.findWorkspaceByPath(root)).toEqual(first);
      expect(await store.findWorkspaceBySourceId("same")).toEqual(first);
    });

    test("list registrations by creation time, then id, one page at a time", async () => {
      const store = (await open())(SCOPE);
      const [low, middle, high] = [
        newWorkspaceId(),
        newWorkspaceId(),
        newWorkspaceId(),
      ].sort();
      // The highest id is created first, so time orders before id does.
      const first = hostWorkspace({
        createdAt: new Date(1000),
        id: high,
        path: newRoot("first"),
      });
      const tiedLow = hostWorkspace({
        createdAt: new Date(2000),
        id: low,
        path: newRoot("tied-low"),
      });
      const tiedHigh = hostWorkspace({
        createdAt: new Date(2000),
        id: middle,
        path: newRoot("tied-high"),
      });
      const ordered = [first, tiedLow, tiedHigh];
      for (const workspace of [tiedHigh, first, tiedLow]) {
        await seed(store, workspace);
      }

      expect(await store.listWorkspaces()).toEqual({
        items: ordered,
        total: 3,
      });
      const firstPage = await store.listWorkspaces({ limit: 2 });
      expect(firstPage.items).toEqual(ordered.slice(0, 2));
      expect(firstPage.total).toBe(3);
      expect(firstPage.nextCursor).toBeDefined();
      const secondPage = await store.listWorkspaces({
        cursor: firstPage.nextCursor,
        limit: 2,
      });
      expect(secondPage.items).toEqual(ordered.slice(2));
      expect(secondPage.total).toBe(3);
      expect(secondPage.nextCursor).toBeUndefined();
    });
  });
}

function describeWrites(open: Open): void {
  describe("writes", () => {
    test("a save replaces the registration and applies entry changes", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "a.md" });
      const removed = fileRecord(workspace.id, { path: "b.md" });
      await seed(store, workspace, [kept, removed]);
      const renamed = { ...workspace, name: "beta", updatedAt: new Date(5) };
      const edited = { ...kept, bytes: 9 };
      const added = fileRecord(workspace.id, { path: "c.md" });

      await store.commit({
        deleteEntries: [removed.id],
        putEntries: [edited, added],
        workspace: renamed,
      });

      expect(await store.getWorkspace(workspace.id)).toEqual(renamed);
      expect(await store.listEntries(workspace.id)).toEqual([edited, added]);
      expect(await store.getEntry(workspace.id, removed.id)).toBeNull();
    });

    test("a save with only a registration leaves its entries alone", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      await seed(store, workspace, [readme]);
      const renamed = { ...workspace, name: "beta" };

      await store.commit({ workspace: renamed });

      expect(await store.getWorkspace(workspace.id)).toEqual(renamed);
      expect(await store.listEntries(workspace.id)).toEqual([readme]);
    });

    test("entry deletes apply before entry puts", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      await seed(store, workspace, [readme]);
      const replaced = { ...readme, bytes: 12 };

      await store.commit({
        deleteEntries: [readme.id],
        putEntries: [replaced],
        workspace,
      });

      expect(await store.getEntry(workspace.id, readme.id)).toEqual(replaced);
    });

    test("a removal deletes the registration and every entry it has", async () => {
      const store = (await open())(SCOPE);
      const first = hostWorkspace({ path: newRoot("alpha") });
      const second = hostWorkspace({ path: newRoot("beta") });
      const firstReadme = fileRecord(first.id, { path: "README.md" });
      const secondReadme = fileRecord(second.id, { path: "README.md" });
      await seed(store, first, [firstReadme]);
      await seed(store, second, [secondReadme]);

      await store.commit({ removeWorkspace: first.id });

      expect(await store.getWorkspace(first.id)).toBeNull();
      expect(await store.findWorkspaceByPath(first.source.path)).toBeNull();
      expect(await store.listEntries(first.id)).toEqual([]);
      expect(await store.listWorkspaces()).toEqual({
        items: [second],
        total: 1,
      });
      expect(await store.listEntries(second.id)).toEqual([secondReadme]);
    });

    test("a removal leaves no entry of its Workspace, whatever it names", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const other = hostWorkspace({ path: newRoot("beta") });
      const named = fileRecord(workspace.id, { path: "a.md" });
      const unnamed = fileRecord(workspace.id, { path: "b.md" });
      // Filed under the Workspace by another Workspace's save.
      const stray = fileRecord(workspace.id, { path: "c.md" });
      await seed(store, workspace, [named, unnamed]);
      await seed(store, other, [stray]);

      // A caller outside the types may still hand a removal entry ids.
      const naming = {
        deleteEntries: [named.id],
        removeWorkspace: workspace.id,
      } as unknown as WorkspaceStoreWrite;
      await store.commit(naming);

      expect(await store.getWorkspace(workspace.id)).toBeNull();
      expect(await store.listEntries(workspace.id)).toEqual([]);
      for (const entry of [named, unnamed, stray]) {
        expect(await store.getEntry(workspace.id, entry.id)).toBeNull();
      }
      expect(await store.getWorkspace(other.id)).toEqual(other);

      // Naming nothing removes them all the same.
      await seed(store, workspace, [named, unnamed]);
      await store.commit({ removeWorkspace: workspace.id });
      expect(await store.listEntries(workspace.id)).toEqual([]);
      expect(await store.getWorkspace(other.id)).toEqual(other);
    });

    test("an entry put again is replaced whole, even when its type changes", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const file = fileRecord(workspace.id, { path: "node" });
      const directory: WorkspaceEntry = {
        ...directoryRecord(workspace.id, "node"),
        id: file.id,
      };
      const symlink: WorkspaceEntry = {
        ...directory,
        target: "elsewhere",
        type: "symlink",
      };
      const again = { ...file, bytes: 12, extension: null, mime: null };

      for (const entry of [file, directory, symlink, again]) {
        await store.commit({ putEntries: [entry], workspace });
        expect(await store.getEntry(workspace.id, file.id)).toEqual(entry);
        expect(await store.listEntries(workspace.id)).toEqual([entry]);
      }
    });

    test("a put files an entry under its own Workspace", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const other = newWorkspaceId();
      const stray = fileRecord(other, { path: "stray.md" });

      await store.commit({ putEntries: [stray], workspace });

      expect(await store.listEntries(workspace.id)).toEqual([]);
      expect(await store.getEntry(workspace.id, stray.id)).toBeNull();
      expect(await store.listEntries(other)).toEqual([stray]);
      expect(await store.getEntry(other, stray.id)).toEqual(stray);
      // A delete names an entry of the write's own Workspace only.
      await store.commit({ deleteEntries: [stray.id], workspace });
      expect(await store.getEntry(other, stray.id)).toEqual(stray);
    });

    test("a removal of an absent Workspace changes nothing", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      await seed(store, workspace);

      await expect(
        store.commit({ removeWorkspace: newWorkspaceId() })
      ).resolves.toBeUndefined();
      expect(await store.listWorkspaces()).toEqual({
        items: [workspace],
        total: 1,
      });
    });
  });
}

function describeAtomicity(open: Open): void {
  describe("atomicity", () => {
    test("a failing save leaves an existing Workspace as it was", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "a.md" });
      const doomed = fileRecord(workspace.id, { path: "b.md" });
      await seed(store, workspace, [kept, doomed]);
      const before = await everything(store, workspace);

      await expect(
        store.commit({
          deleteEntries: [doomed.id],
          putEntries: [
            { ...kept, bytes: 9 },
            fileRecord(workspace.id, { path: "c.md" }),
            fileRecord(workspace.id, {
              createdAt: unstorableDate(),
              path: "d.md",
            }),
          ],
          workspace: { ...workspace, name: "beta", updatedAt: new Date(5) },
        })
      ).rejects.toThrow();

      expect(await everything(store, workspace)).toEqual(before);
    });

    test("a failing first save leaves no Workspace behind", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });

      await expect(
        store.commit({
          putEntries: [
            fileRecord(workspace.id, { path: "a.md" }),
            fileRecord(workspace.id, {
              path: "b.md",
              updatedAt: unstorableDate(),
            }),
          ],
          workspace,
        })
      ).rejects.toThrow();

      expect(await everything(store, workspace)).toEqual({
        entries: [],
        list: { items: [], total: 0 },
        workspace: null,
      });
      expect(await store.findWorkspaceByPath(workspace.source.path)).toBeNull();
    });
  });
}

function describeDetachment(open: Open): void {
  describe("detachment", () => {
    test("a committed value is not shared with the caller", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("detached") });
      const file = fileRecord(workspace.id, { path: "a.md" });
      const expected = {
        entry: structuredClone(file),
        workspace: structuredClone(workspace),
      };
      await seed(store, workspace, [file]);

      scribbleWorkspace(workspace);
      scribbleEntry(file);

      expect(await store.getWorkspace(expected.workspace.id)).toEqual(
        expected.workspace
      );
      expect(await store.getEntry(expected.workspace.id, file.id)).toEqual(
        expected.entry
      );
    });

    test("no read hands out a value the store keeps", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({
        path: newRoot("detached"),
        sourceId: crypto.randomUUID(),
      });
      const file = fileRecord(workspace.id, { path: "a.md" });
      await seed(store, workspace, [file]);
      const { path } = workspace.source;
      const sourceId = workspace.source.sourceId ?? "";

      const reads = {
        byPath: await store.findWorkspaceByPath(path),
        bySourceId: await store.findWorkspaceBySourceId(sourceId),
        entries: await store.listEntries(workspace.id),
        entry: await store.getEntry(workspace.id, file.id),
        list: await store.listWorkspaces(),
        workspace: await store.getWorkspace(workspace.id),
      };
      for (const read of [
        reads.byPath,
        reads.bySourceId,
        reads.workspace,
        ...reads.list.items,
      ]) {
        if (read) {
          scribbleWorkspace(read);
        }
      }
      for (const read of [reads.entry, ...reads.entries]) {
        if (read) {
          scribbleEntry(read);
        }
      }
      (reads.list.items as WorkspaceRegistration[]).length = 0;
      (reads.entries as WorkspaceEntry[]).length = 0;

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.findWorkspaceByPath(path)).toEqual(workspace);
      expect(await store.findWorkspaceBySourceId(sourceId)).toEqual(workspace);
      expect(await store.listWorkspaces()).toEqual({
        items: [workspace],
        total: 1,
      });
      expect(await store.getEntry(workspace.id, file.id)).toEqual(file);
      expect(await store.listEntries(workspace.id)).toEqual([file]);
    });
  });
}

/** A store that offers no `transaction` skips these: it promises no exclusion. */
function describeTransactions(open: Open): void {
  describe("transactions", () => {
    test("an outside commit waits for a running transaction, then lands", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      await seed(store, workspace);
      const read = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();

      const inside = store.transaction(async (view) => {
        const before = await view.getWorkspace(workspace.id);
        read.resolve(undefined);
        await release.promise;
        const after = await view.getWorkspace(workspace.id);
        await view.commit({ workspace: { ...workspace, name: "inside" } });
        return { after, before };
      });
      await read.promise;
      // An independent caller, while the transaction sits between its reads
      // and its commit, given time enough to land if nothing held it back.
      const outside = store.commit({
        workspace: { ...workspace, name: "outside" },
      });
      await pause(20);
      release.resolve(undefined);

      expect(await inside).toEqual({ after: workspace, before: workspace });
      await outside;
      expect((await store.getWorkspace(workspace.id))?.name).toBe("outside");
    });

    test("a transaction that throws keeps none of its commits", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const existing = hostWorkspace({ path: newRoot("existing") });
      const kept = fileRecord(existing.id, { path: "a.md" });
      const doomed = fileRecord(existing.id, { path: "b.md" });
      await seed(store, existing, [kept, doomed]);
      const before = await everything(store, existing);
      const added = hostWorkspace({ path: newRoot("added") });

      await expect(
        store.transaction(async (view) => {
          await view.commit({
            deleteEntries: [doomed.id],
            putEntries: [{ ...kept, bytes: 9 }],
            workspace: { ...existing, name: "renamed" },
          });
          await view.commit({
            putEntries: [fileRecord(added.id, { path: "c.md" })],
            workspace: added,
          });
          await view.commit({ removeWorkspace: existing.id });
          throw new Error("refused");
        })
      ).rejects.toThrow("refused");

      expect(await everything(store, existing)).toEqual(before);
      expect(await store.getEntry(existing.id, doomed.id)).toEqual(doomed);
      expect(await store.getWorkspace(added.id)).toBeNull();
      expect(await store.listEntries(added.id)).toEqual([]);
      expect(await store.findWorkspaceByPath(added.source.path)).toBeNull();
    });

    test("reads through the view see the transaction's own commits", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const removed = hostWorkspace({ path: newRoot("removed") });
      const gone = fileRecord(removed.id, { path: "gone.md" });
      await seed(store, removed, [gone]);
      const added = hostWorkspace({
        path: newRoot("added"),
        sourceId: crypto.randomUUID(),
      });
      const file = fileRecord(added.id, { path: "a.md" });

      const seen = await store.transaction(async (view) => {
        await view.commit({ putEntries: [file], workspace: added });
        await view.commit({ removeWorkspace: removed.id });
        return {
          byPath: await view.findWorkspaceByPath(added.source.path),
          bySourceId: await view.findWorkspaceBySourceId(
            added.source.sourceId ?? ""
          ),
          entries: await view.listEntries(added.id),
          entry: await view.getEntry(added.id, file.id),
          gone: await view.getEntry(removed.id, gone.id),
          list: await view.listWorkspaces(),
          removed: await view.getWorkspace(removed.id),
          workspace: await view.getWorkspace(added.id),
        };
      });

      expect(seen).toEqual({
        byPath: added,
        bySourceId: added,
        entries: [file],
        entry: file,
        gone: null,
        list: { items: [added], total: 1 },
        removed: null,
        workspace: added,
      });
      expect(await store.getWorkspace(added.id)).toEqual(added);
      expect(await store.getWorkspace(removed.id)).toBeNull();
    });

    test("transactions over one store do not lose each other's writes", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      const { transaction } = store;
      if (transaction === undefined) {
        return skip();
      }
      const workspace = hostWorkspace({ name: "0", path: newRoot("alpha") });
      await seed(store, workspace);
      const increment = () =>
        transaction.call(store, async (view) => {
          const current = await view.getWorkspace(workspace.id);
          // Yield so the other increment gets every chance to interleave.
          await new Promise((resolve) => setTimeout(resolve, 1));
          await view.commit({
            workspace: {
              ...workspace,
              name: String(Number(current?.name) + 1),
            },
          });
        });

      await Promise.all([increment(), increment(), increment()]);

      expect((await store.getWorkspace(workspace.id))?.name).toBe("3");
    });

    test("answer with the work's result, and recover from its failure", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const workspace = hostWorkspace({ path: newRoot("alpha") });

      await expect(
        store.transaction(() => Promise.reject(new Error("refused")))
      ).rejects.toThrow("refused");
      expect(
        await store.transaction(async (view) => {
          await view.commit({ putEntries: [], workspace });
          return "done";
        })
      ).toBe("done");
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
    });
  });
}

function describeOrdering(open: Open): void {
  describe("ordering", () => {
    test("break a creation-time tie by id in code-point order", async () => {
      const store = (await open())(SCOPE);
      // U+FF21 sorts before U+1F600 by code point, after it by code unit.
      const fullwidth = hostWorkspace({
        id: "Ａ" as WorkspaceId,
        path: newRoot("fullwidth"),
        sourceId: "tied",
      });
      const astral = hostWorkspace({
        id: "\u{1F600}" as WorkspaceId,
        path: fullwidth.source.path,
        sourceId: "tied",
      });
      await seed(store, astral);
      await seed(store, fullwidth);

      expect((await store.listWorkspaces()).items).toEqual([fullwidth, astral]);
      expect(await store.findWorkspaceByPath(fullwidth.source.path)).toEqual(
        fullwidth
      );
      expect(await store.findWorkspaceBySourceId("tied")).toEqual(fullwidth);
      const first = await store.listWorkspaces({ limit: 1 });
      expect(first.items).toEqual([fullwidth]);
      expect(
        (await store.listWorkspaces({ cursor: first.nextCursor, limit: 1 }))
          .items
      ).toEqual([astral]);
    });

    test("list entries by path in code-unit order, whatever order they were put in", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      // By code unit: "B" < "a" < "\u{1F600}" (a surrogate) < "Ａ".
      const paths = ["Ａ.md", "a.md", "\u{1F600}.md", "B.md"];
      const [fullwidth, lower, astral, upper] = paths.map((path) =>
        fileRecord(workspace.id, { path })
      ) as [WorkspaceFile, WorkspaceFile, WorkspaceFile, WorkspaceFile];
      await seed(store, workspace, [fullwidth, lower]);
      await store.commit({ putEntries: [astral, upper], workspace });
      const edited = { ...fullwidth, bytes: 7 };
      await store.commit({ putEntries: [edited], workspace });

      expect(await store.listEntries(workspace.id)).toEqual([
        upper,
        lower,
        astral,
        edited,
      ]);
    });

    test("break a path tie by id, however the entries were put", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const [low, high] = [newWorkspaceEntryId(), newWorkspaceEntryId()].sort();
      const first = fileRecord(workspace.id, { id: low, path: "same.md" });
      const second = fileRecord(workspace.id, { id: high, path: "same.md" });
      await seed(store, workspace, [second, first]);
      expect(await store.listEntries(workspace.id)).toEqual([first, second]);

      // Put again, and deleted then put, neither moves an entry.
      await store.commit({ putEntries: [first], workspace });
      await store.commit({
        deleteEntries: [second.id],
        putEntries: [second],
        workspace,
      });
      expect(await store.listEntries(workspace.id)).toEqual([first, second]);
    });
  });
}

function describeScopes(open: Open): void {
  describe("scopes", () => {
    test("two scopes on one storage never see each other", async () => {
      const stores = await open();
      const [first, second] = [stores("scope-a"), stores("scope-b")];
      const workspace = hostWorkspace({
        path: newRoot("shared"),
        sourceId: "shared",
      });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      await seed(first, workspace, [readme]);

      expect(await second.getWorkspace(workspace.id)).toBeNull();
      expect(await second.getEntry(workspace.id, readme.id)).toBeNull();
      expect(await second.listEntries(workspace.id)).toEqual([]);
      expect(
        await second.findWorkspaceByPath(workspace.source.path)
      ).toBeNull();
      expect(await second.findWorkspaceBySourceId("shared")).toBeNull();
      expect(await second.listWorkspaces()).toEqual({ items: [], total: 0 });

      // The same ids in the other scope, then removed there.
      const theirs = { ...workspace, name: "theirs" };
      const theirReadme = { ...readme, bytes: 99 };
      await seed(second, theirs, [theirReadme]);
      expect(await second.getEntry(workspace.id, readme.id)).toEqual(
        theirReadme
      );
      await second.commit({ removeWorkspace: workspace.id });

      expect(await first.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await first.listEntries(workspace.id)).toEqual([readme]);
      expect(await first.listWorkspaces()).toEqual({
        items: [workspace],
        total: 1,
      });
      expect(await stores("scope-a").getEntry(workspace.id, readme.id)).toEqual(
        readme
      );
    });
  });
}

function describeLargeWrites(open: Open): void {
  describe("large writes", () => {
    test("one save can put and delete thousands of entries", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("large") });
      const first = manyFiles(workspace.id, "a", 5000);
      await seed(store, workspace, first);
      expect(await store.listEntries(workspace.id)).toHaveLength(5000);

      const second = manyFiles(workspace.id, "b", 5000);
      // More deletes than one statement can bind; most name nothing.
      const absent = Array.from({ length: 33_000 }, newWorkspaceEntryId);
      await store.commit({
        deleteEntries: [...absent, ...first.map((entry) => entry.id)],
        putEntries: second,
        workspace,
      });
      expect(await store.listEntries(workspace.id)).toEqual(second);

      // A removal names no entries, yet takes every one of them.
      await store.commit({ removeWorkspace: workspace.id });
      expect(await everything(store, workspace)).toEqual({
        entries: [],
        list: { items: [], total: 0 },
        workspace: null,
      });
    });
  });
}

function describeReentry(open: Open): void {
  describe("re-entry", () => {
    test("a call to the store from inside its own transaction is refused at once", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const transaction: NonNullable<WorkspaceStore["transaction"]> =
        store.transaction.bind(store);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      const calls: Record<string, () => Promise<unknown>> = {
        commit: () => seed(store, workspace),
        findWorkspaceByPath: () => store.findWorkspaceByPath("/x"),
        findWorkspaceBySourceId: () => store.findWorkspaceBySourceId("x"),
        getEntry: () => store.getEntry(workspace.id, readme.id),
        getWorkspace: () => store.getWorkspace(workspace.id),
        listEntries: () => store.listEntries(workspace.id),
        listWorkspaces: () => store.listWorkspaces(),
        transaction: () => transaction(() => Promise.resolve()),
      };
      const { promise: ended, resolve: end } = Promise.withResolvers<void>();
      let later: Promise<unknown> = Promise.resolve();

      const refusals = await transaction(async (view) => {
        const outcomes: Record<string, string> = {};
        for (const [method, call] of Object.entries(calls)) {
          outcomes[method] = await settlesWithin(call(), 1000);
        }
        // Scheduled from inside, but run once the transaction has ended.
        later = ended.then(() =>
          store.commit({ putEntries: [readme], workspace })
        );
        await view.commit({ workspace: { ...workspace, name: "inside" } });
        return outcomes;
      });
      end();

      expect(Object.keys(refusals)).toHaveLength(8);
      for (const outcome of Object.values(refusals)) {
        expect(outcome).toMatch(REFUSAL);
      }
      await later;
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.listEntries(workspace.id)).toEqual([readme]);
    });
  });
}

/** What a store's refusal of a call from inside its own transaction says. */
const REFUSAL = /refused: .*use the view/;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * How `promise` settled, as `refused: <message>` or `resolved`, or
 * `still pending` after `ms`: a hang becomes a failed assertion, not a
 * stalled suite.
 */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("still pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        (error: unknown) =>
          `refused: ${error instanceof Error ? error.message : String(error)}`
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** `count` files at zero-padded paths under `prefix`, in path order. */
function manyFiles(
  workspaceId: WorkspaceId,
  prefix: string,
  count: number
): WorkspaceFile[] {
  return Array.from({ length: count }, (_, index) =>
    fileRecord(workspaceId, {
      path: `${prefix}${String(index).padStart(5, "0")}.md`,
    })
  );
}

/** Every read over one Workspace, to compare before and after a write. */
async function everything(
  store: WorkspaceStore,
  workspace: WorkspaceRegistration
) {
  return {
    entries: await store.listEntries(workspace.id),
    list: await store.listWorkspaces(),
    workspace: await store.getWorkspace(workspace.id),
  };
}

/**
 * A timestamp no store can keep: it cannot be cloned, compared, or
 * serialized, so a write holding one must fail.
 */
function unstorableDate(): Date {
  const refuse = (): never => {
    throw new Error("This timestamp cannot be stored");
  };
  return {
    [Symbol.toPrimitive]: refuse,
    getTime: refuse,
    toISOString: refuse,
    toJSON: refuse,
    valueOf: refuse,
  } as unknown as Date;
}

/** Changes every mutable part of a registration in place. */
function scribbleWorkspace(workspace: WorkspaceRegistration): void {
  const writable = workspace as {
    name: string;
    source: { path: string; sourceId: string | null };
  };
  workspace.createdAt.setTime(0);
  workspace.lastReconciledAt.setTime(0);
  workspace.updatedAt.setTime(0);
  writable.name = "scribbled";
  writable.source.path = "/scribbled";
  writable.source.sourceId = "scribbled";
}

/** Changes every mutable part of an entry in place. */
function scribbleEntry(entry: WorkspaceEntry): void {
  entry.createdAt.setTime(0);
  entry.updatedAt.setTime(0);
  (entry as { name: string; path: string }).name = "scribbled";
  (entry as { name: string; path: string }).path = "scribbled";
}
