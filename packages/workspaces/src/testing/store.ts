import { describe, expect, test } from "vitest";
import type { WorkspaceStore } from "../store";
import type { WorkspaceEntry, WorkspaceRegistration } from "../types";
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
 * What every `WorkspaceStore` must do. A store enforces no catalog rule, so
 * these cases pin only persistence: every read, both writes, ordering,
 * scoping by Workspace, atomic writes, detached values, and transactions.
 * Each case calls `open` for fresh, empty storage, then opens a store over
 * one scope of it.
 */
export function describeWorkspaceStore(
  name: string,
  open: () => (scope: string) => WorkspaceStore
): void {
  describe(`${name} WorkspaceStore conformance`, () => {
    describeReads(open);
    describeWrites(open);
    describeAtomicity(open);
    describeDetachment(open);
    describeTransactions(open);
  });
}

/** Opens fresh, empty storage, and a store over one scope of it. */
type Open = () => (scope: string) => WorkspaceStore;

/** The one scope every case works in. */
const SCOPE = "workspaces";

function describeReads(open: Open): void {
  describe("reads", () => {
    test("answer an empty store with nothing", async () => {
      const store = open()(SCOPE);
      const absent = newWorkspaceId();

      expect(await store.getWorkspace(absent)).toBeNull();
      expect(await store.getEntry(absent, newWorkspaceEntryId())).toBeNull();
      expect(await store.listEntries(absent)).toEqual([]);
      expect(await store.findWorkspaceByPath(newRoot("absent"))).toBeNull();
      expect(await store.findWorkspaceBySourceId("absent")).toBeNull();
      expect(await store.listWorkspaces()).toEqual({ items: [], total: 0 });
    });

    test("round-trip a registration and its entries in path order", async () => {
      const store = open()(SCOPE);
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

    test("scope entries to their Workspace", async () => {
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      await seed(store, workspace, [readme]);
      const renamed = { ...workspace, name: "beta" };

      await store.commit({ workspace: renamed });

      expect(await store.getWorkspace(workspace.id)).toEqual(renamed);
      expect(await store.listEntries(workspace.id)).toEqual([readme]);
    });

    test("entry deletes apply before entry puts", async () => {
      const store = open()(SCOPE);
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

    test("a removal deletes the registration and the entries it names", async () => {
      const store = open()(SCOPE);
      const first = hostWorkspace({ path: newRoot("alpha") });
      const second = hostWorkspace({ path: newRoot("beta") });
      const firstReadme = fileRecord(first.id, { path: "README.md" });
      const secondReadme = fileRecord(second.id, { path: "README.md" });
      await seed(store, first, [firstReadme]);
      await seed(store, second, [secondReadme]);

      await store.commit({
        deleteEntries: [firstReadme.id],
        removeWorkspace: first.id,
      });

      expect(await store.getWorkspace(first.id)).toBeNull();
      expect(await store.findWorkspaceByPath(first.source.path)).toBeNull();
      expect(await store.listEntries(first.id)).toEqual([]);
      expect(await store.listWorkspaces()).toEqual({
        items: [second],
        total: 1,
      });
      expect(await store.listEntries(second.id)).toEqual([secondReadme]);
    });

    test("a removal deletes only what it names", async () => {
      const store = open()(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const named = fileRecord(workspace.id, { path: "a.md" });
      const unnamed = fileRecord(workspace.id, { path: "b.md" });
      await seed(store, workspace, [named, unnamed]);

      await store.commit({
        deleteEntries: [named.id],
        removeWorkspace: workspace.id,
      });

      expect(await store.getWorkspace(workspace.id)).toBeNull();
      expect(await store.listEntries(workspace.id)).toEqual([unnamed]);
    });

    test("a removal of an absent Workspace changes nothing", async () => {
      const store = open()(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      await seed(store, workspace);

      await expect(
        store.commit({ deleteEntries: [], removeWorkspace: newWorkspaceId() })
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
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
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
      const outside = store.commit({
        workspace: { ...workspace, name: "outside" },
      });
      release.resolve(undefined);

      expect(await inside).toEqual({ after: workspace, before: workspace });
      await outside;
      expect((await store.getWorkspace(workspace.id))?.name).toBe("outside");
    });

    test("a transaction that throws keeps none of its commits", async ({
      skip,
    }) => {
      const store = open()(SCOPE);
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
          await view.commit({
            deleteEntries: [kept.id],
            removeWorkspace: existing.id,
          });
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
      const store = open()(SCOPE);
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
        await view.commit({
          deleteEntries: [gone.id],
          removeWorkspace: removed.id,
        });
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
      const store = open()(SCOPE);
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
      const store = open()(SCOPE);
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
