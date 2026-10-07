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
import { MemoryWorkspaceStore } from "../memory-store";
import { directory } from "../node";
import type { WorkspaceChange } from "../types";
import { WorkspaceSystem } from "../workspace-system";
import { sha256Hex } from "./helpers/digest";

function harness() {
  const store = new MemoryWorkspaceStore();
  return { store, system: new WorkspaceSystem({ store }).extend(directory()) };
}

describe("WorkspaceSystem public operations", () => {
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
    const { system, store } = harness();
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
    const workspace = await system.load({ path: root });
    const initial = await workspace.entries();
    expect(events).toEqual(initial.map((entry) => ({ action: "add", entry })));
    events.length = 0;
    await system.load({ path: root });
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
    const { system } = harness();
    const root = await sourceDirectory({ "file.txt": "first" });
    const workspace = await system.load({ path: root });
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
    const { system, store } = harness();
    const root = await sourceDirectory({ "file.txt": "first" });
    const workspace = await system.load({ path: root });
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
    const commit = store.commit.bind(store);
    const observation = vi
      .spyOn(store, "commit")
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
      expect(events.map((event) => event.action)).toEqual(["change", "delete"]);
      expect(events[1]?.entry).toEqual(events[0]?.entry);
    } finally {
      release.resolve(undefined);
      observation.mockRestore();
      stop();
    }
  });

  test("unsubscribe stops future notifications", async () => {
    const { system } = harness();
    const events: WorkspaceChange[] = [];
    const stop = system.on("change", (change) => {
      events.push(change);
    });
    stop();
    await system.load({
      path: await sourceDirectory({ "file.txt": "one" }),
    });
    expect(events).toEqual([]);
  });

  test("waits for reconciliation when a saved file's catalog update fails", async () => {
    const { system, store } = harness();
    const root = await sourceDirectory({ "file.txt": "first" });
    const workspace = await system.load({ path: root });
    const [file] = await workspace.files();
    if (!file) {
      throw new Error("Expected file");
    }
    const events: WorkspaceChange[] = [];
    const stop = system.on("change", (change) => {
      events.push(change);
    });
    const observation = vi
      .spyOn(store, "commit")
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
    const { system } = harness();
    const root = await sourceDirectory({
      "README.md": "hello",
      "src/deep/app.ts": "const a = 1;\n",
    });

    const added = await system.load({ path: root });

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
    expect((await system.list()).items.map((w) => w.id)).toContain(added.id);
  });

  test("resolves a duplicate add to the Workspace already registered", async () => {
    const { system } = harness();
    const root = await sourceDirectory({ "README.md": "hello" });

    const first = await system.load({ path: root });

    expect((await system.load({ path: root })).id).toBe(first.id);
    expect(
      (await system.list()).items.filter((w) => w.id === first.id)
    ).toHaveLength(1);
  });

  test("reconciles edits, arrivals, a unique move, and departures", async () => {
    const { system } = harness();
    const root = await sourceDirectory({
      "drop.md": "temporary",
      "README.md": "first",
      "src/notes.md": "one of a kind",
    });
    const added = await system.load({ path: root });
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
    expect(view.entries.find((file) => file.path === "docs/notes.md")?.id).toBe(
      moved?.id
    );
    expect(view.entries.find((file) => file.path === "README.md")?.id).toBe(
      edited?.id
    );
    expect(await added.entries()).toEqual(view.entries);
  });

  test("returns the prior catalog beside an unavailable source", async () => {
    const { system } = harness();
    const root = await sourceDirectory({ "README.md": "hello" });
    const added = await system.load({ path: root });
    const before = await added.files();

    await rm(root, { force: true, recursive: true });
    const view = await added.refresh();

    expect(view.source).toMatchObject({ kind: "unavailable" });
    expect(view.entries).toEqual(before);
    expect(await added.summary()).toBeTruthy();
  });

  test("removes a Workspace and its Files without touching the source", async () => {
    const { system, store } = harness();
    const root = await sourceDirectory({
      "README.md": "hello",
      "src/app.ts": "1",
    });
    const added = await system.load({ path: root });

    await added.remove();

    expect(await store.getWorkspace(added.id)).toBeNull();
    expect(await store.listEntries(added.id)).toEqual([]);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("hello");
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe("1");
  });

  test("reads the source's current text, not the catalogued facts", async () => {
    const { system } = harness();
    const root = await sourceDirectory({ "README.md": "first" });
    const added = await system.load({ path: root });
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
    const { system, store } = harness();
    const root = await sourceDirectory({ "notes.md": "before" });
    const added = await system.load({ path: root });
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
    const { system } = harness();
    const root = await sourceDirectory({ "notes.md": "mine" });
    const added = await system.load({ path: root });
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
