import { describe, expect, test } from "vitest";
import type { WorkspaceStore } from "../../store";
import {
  artifactWorkspace,
  directoryRecord,
  fileRecord,
  hostWorkspace,
  newRoot,
  newWorkspaceId,
  seed,
} from "./fixtures";

/**
 * What every `WorkspaceStore` must do. A store enforces no catalog rule, so
 * these cases pin only persistence: round trips, ordering, scoping, atomic
 * writes, and detached values.
 */
export function describeWorkspaceStoreConformance(
  name: string,
  createStore: () => WorkspaceStore | Promise<WorkspaceStore>
): void {
  describe(`${name} WorkspaceStore conformance`, () => {
    test("round-trips a registration and its entries in path order", async () => {
      const store = await createStore();
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const docs = directoryRecord(workspace.id, "docs");
      const readme = fileRecord(workspace.id, { path: "README.md" });
      const guide = fileRecord(workspace.id, { path: "docs/guide.md" });
      await seed(store, workspace, [guide, docs, readme]);

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.listEntries(workspace.id)).toEqual([
        readme,
        docs,
        guide,
      ]);
      expect(await store.getEntry(workspace.id, guide.id)).toEqual(guide);
    });

    test("applies puts and deletes beside an updated registration", async () => {
      const store = await createStore();
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
    });

    test("scopes entries to their Workspace", async () => {
      const store = await createStore();
      const first = hostWorkspace({ path: newRoot("alpha") });
      const second = hostWorkspace({ path: newRoot("beta") });
      const firstReadme = fileRecord(first.id, { path: "README.md" });
      const secondReadme = fileRecord(second.id, { path: "README.md" });
      await seed(store, first, [firstReadme]);
      await seed(store, second, [secondReadme]);

      expect(await store.getEntry(first.id, secondReadme.id)).toBeNull();
      expect(await store.listEntries(second.id)).toEqual([secondReadme]);

      await store.removeWorkspace(first.id);
      expect(await store.getWorkspace(first.id)).toBeNull();
      expect(await store.listEntries(first.id)).toEqual([]);
      expect(await store.listEntries(second.id)).toEqual([secondReadme]);
    });

    test("finds the oldest registration by root or source reference", async () => {
      const store = await createStore();
      const artifactId = crypto.randomUUID();
      const older = artifactWorkspace(artifactId, newRoot("older"));
      const newer = {
        ...artifactWorkspace(artifactId, newRoot("newer")),
        createdAt: new Date(2000),
      };
      await seed(store, newer);
      await seed(store, older);

      expect(await store.findWorkspaceByPath(newer.source.path)).toEqual(newer);
      expect(await store.findWorkspaceBySourceId(artifactId)).toEqual(older);
      expect(await store.findWorkspaceByPath(newRoot("absent"))).toBeNull();
      expect(await store.findWorkspaceBySourceId("absent")).toBeNull();
    });

    test("lists registrations by creation time, then id, one page at a time", async () => {
      const store = await createStore();
      const first = hostWorkspace({
        createdAt: new Date(1000),
        path: newRoot("first"),
      });
      const second = hostWorkspace({
        createdAt: new Date(2000),
        path: newRoot("second"),
      });
      await seed(store, second);
      await seed(store, first);

      const firstPage = await store.listWorkspaces({ limit: 1 });
      const secondPage = await store.listWorkspaces({
        cursor: firstPage.nextCursor,
        limit: 1,
      });
      expect(firstPage.total).toBe(2);
      expect(firstPage.items).toEqual([first]);
      expect(secondPage.items).toEqual([second]);
      expect(secondPage.nextCursor).toBeUndefined();
    });

    test("never shares objects with its callers", async () => {
      const store = await createStore();
      const workspace = hostWorkspace({ path: newRoot("detached") });
      const file = fileRecord(workspace.id, { path: "a.md" });
      await seed(store, workspace, [file]);

      file.updatedAt.setTime(0);
      (await store.getWorkspace(workspace.id))?.createdAt.setTime(0);
      (await store.listEntries(workspace.id))[0]?.createdAt.setTime(0);

      expect((await store.getWorkspace(workspace.id))?.createdAt).toEqual(
        new Date(1000)
      );
      expect(await store.getEntry(workspace.id, file.id)).toMatchObject({
        createdAt: new Date(1000),
        updatedAt: new Date(1000),
      });
    });

    test("answers absent ids with nothing", async () => {
      const store = await createStore();
      const absent = newWorkspaceId();
      expect(await store.getWorkspace(absent)).toBeNull();
      expect(await store.listEntries(absent)).toEqual([]);
      await expect(store.removeWorkspace(absent)).resolves.toBeUndefined();
    });
  });
}
