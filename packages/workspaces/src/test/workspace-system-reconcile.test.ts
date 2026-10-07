import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkspacePersistenceError,
  WorkspaceSourceUnavailableError,
} from "../errors";
import { MemoryWorkspaceStore } from "../memory-store";
import { nodeFileSystem } from "../node";
import type { WorkspaceStore } from "../store";
import type { WorkspaceFileSystem } from "../types";

import { directorySystem } from "./helpers/directory-system";
import { fileRecord } from "./helpers/fixtures";
import { makeRoot, systemOver } from "./helpers/temp-roots";

describe("reconciliation", () => {
  async function opened(tree: Record<string, string>) {
    const root = await makeRoot(tree);
    const store = new MemoryWorkspaceStore();
    const system = systemOver(store);
    const added = await system.load({ path: root });
    const files = await added.files();
    return { added, files, id: added.id, root, store, system };
  }

  function idsByPath(entries: readonly { path: string; id: string }[]) {
    return Object.fromEntries(entries.map((file) => [file.path, file.id]));
  }

  it("applies an edit, an addition, and a deletion in one observation", async () => {
    const { root, added, files } = await opened({
      "drop.md": "temporary",
      "README.md": "first",
    });
    const before = idsByPath(files);

    await writeFile(join(root, "README.md"), "second");
    await rm(join(root, "drop.md"));
    await writeFile(join(root, "added.md"), "new");

    const view = await added.refresh();

    expect(view.source).toEqual({ kind: "reconciled" });
    expect(
      view.entries
        .filter((entry) => entry.type === "file")
        .map((file) => file.path)
    ).toEqual(["README.md", "added.md"]);
    const after = idsByPath(view.entries);
    expect(after["README.md"]).toBe(before["README.md"]);
    expect(Object.values(after)).not.toContain(before["drop.md"]);
    expect(view.entries[0]).toMatchObject({ bytes: 6 });
  });

  it("leaves an untouched catalog byte-for-byte identical", async () => {
    const { added, files } = await opened({ "README.md": "first" });

    const view = await added.refresh();

    expect(view.entries).toEqual(files);
    expect(view.workspace).toEqual(await added.summary());
  });

  it("keeps one File id across a move only one story explains", async () => {
    const { root, added, files } = await opened({
      "src/notes.md": "unique content",
    });

    await mkdir(join(root, "docs"), { recursive: true });
    await rm(join(root, "src", "notes.md"));
    await writeFile(join(root, "docs", "notes.md"), "unique content");

    const view = await added.refresh();

    expect(
      view.entries
        .filter((entry) => entry.type === "file")
        .map((file) => file.path)
    ).toEqual(["docs/notes.md"]);
    expect(view.entries.find((entry) => entry.type === "file")?.id).toBe(
      files[0]?.id
    );
    expect(
      view.entries.find((entry) => entry.type === "file")?.createdAt
    ).toEqual(files[0]?.createdAt);
  });

  it("deletes and recreates when a move is ambiguous", async () => {
    const { root, added, files } = await opened({
      "a.md": "identical",
      "b.md": "identical",
    });
    const before = new Set(files.map((file) => file.id));

    await mkdir(join(root, "moved"), { recursive: true });
    await rm(join(root, "a.md"));
    await rm(join(root, "b.md"));
    await writeFile(join(root, "moved", "a.md"), "identical");
    await writeFile(join(root, "moved", "b.md"), "identical");

    const view = await added.refresh();

    expect(
      view.entries
        .filter((entry) => entry.type === "file")
        .map((file) => file.path)
    ).toEqual(["moved/a.md", "moved/b.md"]);
    for (const file of view.entries) {
      expect(before.has(file.id)).toBe(false);
    }
  });

  it("deletes rows a new nested ignore rule excludes", async () => {
    const { root, added } = await opened({
      "pkg/keep.ts": "1",
      "pkg/local.json": "{}",
    });

    await writeFile(join(root, "pkg", ".gitignore"), "local.json\n");

    expect(
      (await added.refresh()).entries
        .filter((entry) => entry.type === "file")
        .map((file) => file.path)
    ).toEqual(["pkg/.gitignore", "pkg/keep.ts"]);
  });

  it("preserves the prior catalog exactly when the scan fails partway", async () => {
    const { root, store, added, id, files } = await opened({
      "a.md": "first",
      "b.md": "second",
    });
    await writeFile(join(root, "c.md"), "third");
    const failing: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile(path) {
        return path.endsWith("b.md")
          ? Promise.reject(Object.assign(new Error("io"), { code: "EIO" }))
          : nodeFileSystem.readFile(path);
      },
    };

    const view = await (
      await directorySystem({ filesystem: failing, store }).open(id)
    ).refresh();

    expect(view.source).toEqual({
      kind: "scan-failed",
      reason: "Could not read b.md",
    });
    expect(view.entries).toEqual(files);
    expect(await added.files()).toEqual(files);
  });

  it("reports an unavailable root beside the catalog it still knows", async () => {
    const { root, added, files } = await opened({ "README.md": "hi" });

    await rm(root, { recursive: true });
    const view = await added.refresh();

    expect(view.source).toMatchObject({ kind: "unavailable" });
    expect(view.entries).toEqual(files);
    expect(JSON.stringify(view)).not.toContain(root);
  });

  it("never matches a move across Workspace ownership", async () => {
    const store = new MemoryWorkspaceStore();
    const system = systemOver(store);
    const left = await makeRoot({ "twin.md": "identical bytes" });
    const right = await makeRoot({ "other.md": "unrelated" });
    const leftWorkspace = await system.load({ path: left });
    const rightWorkspace = await system.load({ path: right });
    const [leftFile] = await leftWorkspace.files();

    // The right Workspace gains a File with the left's exact fingerprint while
    // the left loses nothing. A fingerprint index that ignored ownership would
    // hand the left's id to the right's new File.
    await writeFile(join(right, "twin.md"), "identical bytes");

    const view = await rightWorkspace.refresh();

    expect(view.entries.map((file) => file.id)).not.toContain(leftFile?.id);
    expect((await leftWorkspace.files())[0]).toEqual(leftFile);
  });

  it("reconciles an add of a root that is already registered", async () => {
    const { root, system, id, files } = await opened({ "README.md": "first" });
    await writeFile(join(root, "second.md"), "more");

    const again = await system.load({ path: root });

    expect(again.id).toBe(id);
    expect((await again.summary()).fileCount).toBe(2);
    const after = await again.files();
    expect(after.map((file) => file.path)).toEqual(["README.md", "second.md"]);
    expect(after[0]?.id).toBe(files[0]?.id);
  });

  it("serves the last catalog without reaching for the source at all", async () => {
    const { store, id, files } = await opened({
      "README.md": "first",
      "src/app.ts": "1",
    });
    const reached: string[] = [];
    const refusing = (operation: string) => (path: string) => {
      reached.push(`${operation} ${path}`);
      return Promise.reject(new Error("the source must not be touched"));
    };
    const unreachable: WorkspaceFileSystem = {
      lstat: refusing("lstat"),
      readDirectory: refusing("readDirectory"),
      readFile: refusing("readFile"),
      readLink: (path) => nodeFileSystem.readLink(path),
      realpath: refusing("realpath"),
      replaceFile: refusing("replaceFile"),
      separator: nodeFileSystem.separator,
    };
    const offline = directorySystem({ filesystem: unreachable, store });
    const workspace = await offline.open(id);

    // `files` is the last successful observation, not a new one. A read that
    // scanned would make every page load cost a walk — and would fail
    // outright whenever the source is away.
    expect(await workspace.files()).toEqual(files);
    expect(await workspace.summary()).toEqual(
      await (await systemOver(store).open(id)).summary()
    );
    expect((await offline.list()).items.map((w) => w.id)).toEqual([id]);
    expect(reached).toEqual([]);
  });

  /**
   * A filesystem that holds its first root listing open after it has been
   * read: that scan has observed the source and waits, stale, until released.
   * Later listings pass straight through.
   */
  function heldScan(root: string) {
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let scans = 0;
    const filesystem: WorkspaceFileSystem = {
      ...nodeFileSystem,
      async readDirectory(path) {
        const entries = await nodeFileSystem.readDirectory(path);
        if (path === root) {
          scans += 1;
          if (scans === 1) {
            started.resolve(undefined);
            await release.promise;
          }
        }
        return entries;
      },
    };
    return {
      filesystem,
      /**
       * Releases once `competing` settles or has visibly stalled. A queued
       * caller stalls behind the held scan; an unqueued one would race past
       * it, and releasing only then is what lets a stale scan commit last.
       */
      async releaseAfter(competing: Promise<unknown>) {
        await Promise.race([
          competing.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 50)),
        ]);
        release.resolve(undefined);
      },
      scans: () => scans,
      started: started.promise,
    };
  }

  it("never answers a refresh with a scan that began before it was asked", async () => {
    const { root, store, id } = await opened({ "README.md": "first" });
    const held = heldScan(root);
    const workspace = await directorySystem({
      filesystem: held.filesystem,
      store,
    }).open(id);

    const stale = workspace.refresh();
    await held.started;
    await writeFile(join(root, "second.md"), "more");
    const current = workspace.refresh();
    await held.releaseAfter(current);
    const [, latest] = await Promise.all([stale, current]);

    expect(held.scans()).toBe(2);
    expect(latest.entries.map((file) => file.path)).toEqual([
      "README.md",
      "second.md",
    ]);
    expect((await store.listEntries(id)).map((file) => file.path)).toEqual([
      "README.md",
      "second.md",
    ]);
  });

  it("queues a reopened instance behind its predecessor's observation", async () => {
    const { root, store, id } = await opened({ "README.md": "first" });
    await writeFile(join(root, "second.md"), "more");
    // The first commit is held after its diff was computed: an observation
    // that started meanwhile would diff against the same pre-commit rows,
    // mint a second id for `second.md`, and collide when it commits.
    const committing = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let commits = 0;
    const holding: WorkspaceStore = {
      commit: async (write) => {
        commits += 1;
        if (commits === 1) {
          committing.resolve(undefined);
          await release.promise;
        }
        return store.commit(write);
      },
      findWorkspaceByPath: (path) => store.findWorkspaceByPath(path),
      findWorkspaceBySourceId: (sourceId) =>
        store.findWorkspaceBySourceId(sourceId),
      getEntry: (workspaceId, entryId) => store.getEntry(workspaceId, entryId),
      getWorkspace: (workspaceId) => store.getWorkspace(workspaceId),
      listEntries: (workspaceId) => store.listEntries(workspaceId),
      listWorkspaces: (input) => store.listWorkspaces(input),
      removeWorkspace: (workspaceId) => store.removeWorkspace(workspaceId),
    };
    const system = directorySystem({ store: holding });

    // Closing stops an instance but does not wait for its refresh; the queue
    // is the system's, so the reopened instance waits behind it anyway.
    const before = await system.open(id);
    const inFlight = before.refresh();
    await committing.promise;
    await system.close(id);
    const after = await system.open(id);
    expect(after).not.toBe(before);
    const reopened = after.refresh();
    // A queued refresh stalls here; an unqueued one reaches the catalog.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release.resolve(undefined);
    const [left, right] = await Promise.all([inFlight, reopened]);

    expect(idsByPath(right.entries)).toEqual(idsByPath(left.entries));
    expect((await store.listEntries(id)).map((file) => file.path)).toEqual([
      "README.md",
      "second.md",
    ]);
  });

  it("observes again once the previous observation has finished", async () => {
    const { root, store, id } = await opened({ "README.md": "first" });
    let scans = 0;
    const counted: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readDirectory(path) {
        if (path === root) {
          scans += 1;
        }
        return nodeFileSystem.readDirectory(path);
      },
    };
    const workspace = await directorySystem({
      filesystem: counted,
      store,
    }).open(id);

    // The guard is an in-flight join, not a cache: a later refresh has to see
    // the source again or an explicit refresh would stop meaning anything.
    await workspace.refresh();
    await writeFile(join(root, "second.md"), "more");
    const second = await workspace.refresh();

    expect(scans).toBe(2);
    expect(second.entries.map((file) => file.path)).toEqual([
      "README.md",
      "second.md",
    ]);
  });

  it("reports a broken source from a re-add the way a first add does", async () => {
    const { root, store, id, files } = await opened({ "README.md": "hi" });
    const failing: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile(path) {
        return path.endsWith("README.md")
          ? Promise.reject(Object.assign(new Error("io"), { code: "EIO" }))
          : nodeFileSystem.readFile(path);
      },
    };

    // A first add throws here. A re-add that returned an instance instead
    // would report success over a source it could not read.
    await expect(
      directorySystem({ filesystem: failing, store }).load({ path: root })
    ).rejects.toBeInstanceOf(WorkspaceSourceUnavailableError);
    expect(await store.listEntries(id)).toEqual(
      files.map((file) => ({ ...file, workspaceId: id }))
    );
  });

  it("keeps the prior catalog when the catalog refuses the commit", async () => {
    const { root, store, id, files } = await opened({ "README.md": "first" });
    await writeFile(join(root, "second.md"), "more");
    // The diff is computed from the first read; by the catalog's own read a
    // row already holds `second.md`, so the arrival collides and is refused.
    const phantom = fileRecord(id, { path: "second.md" });
    let reads = 0;
    const refusing: WorkspaceStore = {
      commit: (write) => store.commit(write),
      findWorkspaceByPath: (path) => store.findWorkspaceByPath(path),
      findWorkspaceBySourceId: (sourceId) =>
        store.findWorkspaceBySourceId(sourceId),
      getEntry: (workspaceId, entryId) => store.getEntry(workspaceId, entryId),
      getWorkspace: (workspaceId) => store.getWorkspace(workspaceId),
      listEntries: async (workspaceId) => {
        const rows = await store.listEntries(workspaceId);
        reads += 1;
        return reads === 2 ? [...rows, phantom] : rows;
      },
      listWorkspaces: (input) => store.listWorkspaces(input),
      removeWorkspace: (workspaceId) => store.removeWorkspace(workspaceId),
    };

    const failure = await directorySystem({ store: refusing })
      .open(id)
      .then((workspace) => workspace.refresh())
      .then(
        () => null,
        (error: unknown) => error as Error
      );

    expect(failure).toBeInstanceOf(WorkspacePersistenceError);
    // The catalog's reason travels as a cause for the log, never as text that
    // could be shown.
    expect(failure?.message).toBe(`Could not reconcile Workspace ${id}`);
    expect(String((failure as { cause?: unknown } | null)?.cause)).toContain(
      "Duplicate storage path"
    );
    expect((await store.listEntries(id)).map((file) => file.path)).toEqual(
      files.map((file) => file.path)
    );
    expect((await store.listEntries(id)).map((file) => file.id)).toEqual(
      files.map((file) => file.id)
    );
  });
});
