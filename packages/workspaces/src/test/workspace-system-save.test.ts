import type {
  SaveFileResult,
  WorkspaceFileSystem,
  WorkspaceId,
  WorkspaceStore,
} from "../types";

/**
 * Host write authority. Exact-version reads feed `save`; every
 * confinement check re-runs before an atomic replacement; conflict, stale,
 * and failed outcomes are proven against real temporary directories with
 * injected filesystem and store faults. `failed` always means the original
 * bytes are unchanged.
 */

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { WorkspaceFileNotFoundError, WorkspaceNotFoundError } from "../errors";

import { InMemoryWorkspaceStore } from "../in-memory-workspace-store";
import { nodeFileSystem, sha256Hex } from "../node";

import { directorySystem } from "./helpers/directory-system";
import {
  fileRecord,
  hostWorkspace,
  newWorkspaceEntryId,
} from "./helpers/workspace-system-conformance";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function makeRoot(
  tree: Record<string, string | Uint8Array>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "foundry-workspace-save-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolute = join(root, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
  return await nodeFileSystem.realpath(root);
}

function digestOf(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

async function opened(
  tree: Record<string, string | Uint8Array>,
  filesystem: WorkspaceFileSystem = nodeFileSystem
) {
  const root = await makeRoot(tree);
  const store = new InMemoryWorkspaceStore();
  const system = directorySystem({ filesystem, store });
  const workspace = await system.load({ path: root });
  const files = await workspace.files();
  return { files, id: workspace.id, root, store, system, workspace };
}

function one<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) {
    throw new Error("expected exactly one item");
  }
  return item;
}

function countingWrites(): {
  filesystem: WorkspaceFileSystem;
  writes: () => number;
} {
  let calls = 0;
  return {
    filesystem: {
      ...nodeFileSystem,
      replaceFile: (path, bytes) => {
        calls += 1;
        return nodeFileSystem.replaceFile(path, bytes);
      },
    },
    writes: () => calls,
  };
}

describe("save", () => {
  it("saves a same-version draft, returns the written snapshot, and records the catalog", async () => {
    const { filesystem, writes } = countingWrites();
    const { root, store, workspace, id, files } = await opened(
      { "README.md": "first" },
      filesystem
    );
    const file = one(files);

    const read = await workspace.read(file.id);
    if (read.kind !== "text") {
      throw new Error("expected a text read");
    }

    const result = await workspace.save({
      expectedDigest: read.digest,
      fileId: file.id,
      text: "second draft",
    });

    expect(result).toEqual({
      catalog: "current",
      kind: "saved",
      snapshot: {
        bytes: 12,
        digest: digestOf("second draft"),
        text: "second draft",
      },
    });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(
      "second draft"
    );
    expect(writes()).toBe(1);

    const row = one(await store.listEntries(id));
    expect(row).toMatchObject({
      bytes: 12,
      digest: digestOf("second draft"),
      id: file.id,
      path: "README.md",
    });
    expect(row.updatedAt.getTime()).toBeGreaterThan(file.updatedAt.getTime());
    expect(row.createdAt).toEqual(file.createdAt);
  });

  it("chains read version to save: the returned snapshot's digest is the next expected version", async () => {
    const { workspace, files } = await opened({ "a.txt": "v1" });
    const file = one(files);

    const first = await workspace.save({
      expectedDigest: digestOf("v1"),
      fileId: file.id,
      text: "v2",
    });
    if (first.kind !== "saved") {
      throw new Error("expected saved");
    }

    const second = await workspace.save({
      expectedDigest: first.snapshot.digest,
      fileId: file.id,
      text: "v3",
    });

    expect(second).toMatchObject({ catalog: "current", kind: "saved" });
    expect(await workspace.read(file.id)).toMatchObject({
      digest: digestOf("v3"),
      text: "v3",
    });
  });

  it("returns conflict with the current snapshot when the bytes changed after the read", async () => {
    const { filesystem, writes } = countingWrites();
    const { root, store, workspace, id, files } = await opened(
      { "README.md": "mine base" },
      filesystem
    );
    const file = one(files);

    await writeFile(join(root, "README.md"), "external change");

    const result = await workspace.save({
      expectedDigest: digestOf("mine base"),
      fileId: file.id,
      text: "my draft",
    });

    expect(result).toEqual({
      current: {
        bytes: 15,
        digest: digestOf("external change"),
        text: "external change",
      },
      kind: "conflict",
    });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(
      "external change"
    );
    expect(one(await store.listEntries(id))).toMatchObject({
      digest: digestOf("mine base"),
    });
    expect(writes()).toBe(0);
  });

  it("throws for an unknown Workspace or File", async () => {
    const { system, workspace } = await opened({ "a.txt": "x" });

    await expect(system.open("missing" as WorkspaceId)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
    await expect(
      workspace.save({
        expectedDigest: digestOf("x"),
        fileId: newWorkspaceEntryId(),
        text: "x",
      })
    ).rejects.toBeInstanceOf(WorkspaceFileNotFoundError);
  });

  it("throws once the Workspace behind an instance is removed", async () => {
    const { workspace, files } = await opened({ "a.txt": "x" });
    await workspace.remove();

    await expect(
      workspace.save({
        expectedDigest: digestOf("x"),
        fileId: one(files).id,
        text: "x",
      })
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});

describe("save refusals", () => {
  it("reports a removed File as stale with the draft unwritten", async () => {
    const { filesystem, writes } = countingWrites();
    const { root, workspace, files } = await opened(
      { "gone.md": "here" },
      filesystem
    );

    await unlink(join(root, "gone.md"));

    const result = await workspace.save({
      expectedDigest: digestOf("here"),
      fileId: one(files).id,
      text: "draft",
    });

    expect(result).toMatchObject({ kind: "stale" });
    await expect(lstat(join(root, "gone.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(writes()).toBe(0);
  });

  it("reports a File replaced by a directory as stale", async () => {
    const { root, workspace, files } = await opened({ "swap.md": "text" });

    await unlink(join(root, "swap.md"));
    await mkdir(join(root, "swap.md"));

    const result = await workspace.save({
      expectedDigest: digestOf("text"),
      fileId: one(files).id,
      text: "draft",
    });

    expect(result).toMatchObject({ kind: "stale" });
    expect((await lstat(join(root, "swap.md"))).isDirectory()).toBe(true);
  });

  it("refuses a final-component symlink placed after cataloging", async () => {
    const { root, workspace, files } = await opened({
      "linked.md": "original",
      "target.md": "safe",
    });
    const linked = files.find((file) => file.path === "linked.md");
    if (!linked) {
      throw new Error("expected linked.md");
    }

    await unlink(join(root, "linked.md"));
    await symlink(join(root, "target.md"), join(root, "linked.md"));

    const result = await workspace.save({
      expectedDigest: digestOf("original"),
      fileId: linked.id,
      text: "draft through the link",
    });

    expect(result).toMatchObject({ kind: "stale" });
    expect(await readFile(join(root, "target.md"), "utf8")).toBe("safe");
  });

  it("refuses an ancestor symlink that resolves the File outside the root", async () => {
    const { root, workspace, files } = await opened({
      "dir/inner.md": "inside",
    });
    const outside = await makeRoot({ "inner.md": "outside truth" });

    await rm(join(root, "dir"), { recursive: true });
    await symlink(outside, join(root, "dir"));

    const result = await workspace.save({
      expectedDigest: digestOf("inside"),
      fileId: one(files).id,
      text: "escape attempt",
    });

    expect(result).toMatchObject({ kind: "failed" });
    expect(await readFile(join(outside, "inner.md"), "utf8")).toBe(
      "outside truth"
    );
  });

  it("refuses a stored path that lexically escapes the root", async () => {
    const root = await makeRoot({ "safe.md": "x" });
    const store = new InMemoryWorkspaceStore();
    const registered = hostWorkspace({ path: root });
    const escaping = fileRecord(registered.id, { path: "../evil.md" });
    expect(() =>
      store.commitCreate({ entries: [escaping], workspace: registered })
    ).toThrow("Invalid storage path");
    expect(await store.getWorkspace(registered.id)).toBeNull();

    await expect(lstat(join(root, "..", "evil.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a File whose current bytes are binary as stale", async () => {
    const { root, workspace, files } = await opened({ "doc.md": "text" });

    await writeFile(join(root, "doc.md"), Buffer.from([0xff, 0x00, 0x01]));

    const result = await workspace.save({
      expectedDigest: digestOf("text"),
      fileId: one(files).id,
      text: "draft",
    });

    expect(result).toMatchObject({ kind: "stale" });
    expect(new Uint8Array(await readFile(join(root, "doc.md")))).toEqual(
      new Uint8Array([0xff, 0x00, 0x01])
    );
  });

  it("refuses a draft that cannot round-trip as UTF-8 text", async () => {
    const { workspace, root, files } = await opened({ "a.txt": "clean" });

    const result = await workspace.save({
      expectedDigest: digestOf("clean"),
      fileId: one(files).id,
      text: ["nul", "inside"].join(String.fromCharCode(0)),
    });

    expect(result).toMatchObject({ kind: "failed" });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("clean");
  });

  it("returns failed with unchanged bytes when the conflict-check read fails", async () => {
    // The add scans through the real filesystem; only the saving system's
    // read is denied, so the failure lands at the final conflict check.
    const { root, store, id, files } = await opened({ "a.txt": "original" });
    const denied = directorySystem({
      filesystem: {
        ...nodeFileSystem,
        readFile: () =>
          Promise.reject(
            Object.assign(new Error("denied"), { code: "EACCES" })
          ),
      },
      store,
    });

    const result = await (await denied.open(id)).save({
      expectedDigest: digestOf("original"),
      fileId: one(files).id,
      text: "draft",
    });

    expect(result).toEqual({
      kind: "failed",
      reason: "Could not read a.txt (EACCES)",
    });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original");
  });

  it("returns failed and leaves the original when replacement itself fails", async () => {
    const { root, workspace, files } = await opened(
      { "a.txt": "original" },
      {
        ...nodeFileSystem,
        replaceFile: () =>
          Promise.reject(Object.assign(new Error("boom"), { code: "EIO" })),
      }
    );

    const result = await workspace.save({
      expectedDigest: digestOf("original"),
      fileId: one(files).id,
      text: "draft",
    });

    expect(result).toEqual({
      kind: "failed",
      reason: "Could not save a.txt (EIO)",
    });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original");
  });

  it("never places an absolute path in any outcome", async () => {
    const { root, workspace, files } = await opened({ "a.txt": "original" });
    const file = one(files);
    const results: SaveFileResult[] = [];

    await writeFile(join(root, "a.txt"), "changed");
    results.push(
      await workspace.save({
        expectedDigest: digestOf("original"),
        fileId: file.id,
        text: "draft",
      })
    );
    await unlink(join(root, "a.txt"));
    results.push(
      await workspace.save({
        expectedDigest: digestOf("original"),
        fileId: file.id,
        text: "draft",
      })
    );

    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(tmpdir());
    }
  });
});

describe("catalog observation after write", () => {
  function observationFault(
    store: InMemoryWorkspaceStore,
    fail: () => ReturnType<WorkspaceStore["commitFileObservation"]>
  ): WorkspaceStore {
    return {
      afterCommit: (callback) => {
        store.afterCommit(callback);
      },
      commitCreate: (input) => store.commitCreate(input),
      commitFileObservation: () => fail(),
      commitReconcile: (input) => store.commitReconcile(input),
      countFiles: (workspaceId) => store.countFiles(workspaceId),
      findWorkspaceByPath: (path) => store.findWorkspaceByPath(path),
      getEntry: (workspaceId, fileId) => store.getEntry(workspaceId, fileId),
      getWorkspace: (workspaceId) => store.getWorkspace(workspaceId),
      listEntries: (workspaceId) => store.listEntries(workspaceId),
      listWorkspaces: () => store.listWorkspaces(),
      removeWorkspace: (workspaceId) => store.removeWorkspace(workspaceId),
      renameWorkspace: (workspaceId, name, updatedAt) =>
        store.renameWorkspace(workspaceId, name, updatedAt),
    };
  }

  it("returns saved/refresh-required when the catalog commit throws, then reconciles", async () => {
    const { filesystem, writes } = countingWrites();
    const root = await makeRoot({ "README.md": "first" });
    const inner = new InMemoryWorkspaceStore();
    const faulty = observationFault(inner, () =>
      Promise.reject(new Error("catalog write refused"))
    );
    const system = directorySystem({ filesystem, store: faulty });
    const workspace = await system.load({ path: root });
    const file = one(await workspace.files());

    const result = await workspace.save({
      expectedDigest: digestOf("first"),
      fileId: file.id,
      text: "second",
    });

    expect(result).toEqual({
      catalog: "refresh-required",
      kind: "saved",
      snapshot: {
        bytes: 6,
        digest: digestOf("second"),
        text: "second",
      },
    });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("second");
    expect(one(await inner.listEntries(workspace.id))).toMatchObject({
      digest: digestOf("first"),
    });
    expect(writes()).toBe(1);

    const recovered = directorySystem({ filesystem, store: inner });
    await (await recovered.open(workspace.id)).refresh();
    expect(one(await inner.listEntries(workspace.id))).toMatchObject({
      digest: digestOf("second"),
    });
    expect(writes()).toBe(1);
  });

  it("returns saved/refresh-required when the store refuses the observation", async () => {
    const root = await makeRoot({ "README.md": "first" });
    const inner = new InMemoryWorkspaceStore();
    const refusing = observationFault(inner, () =>
      Promise.resolve({ kind: "path-mismatch" as const })
    );
    const system = directorySystem({ store: refusing });
    const workspace = await system.load({ path: root });
    const file = one(await workspace.files());

    const result = await workspace.save({
      expectedDigest: digestOf("first"),
      fileId: file.id,
      text: "second",
    });

    expect(result).toMatchObject({
      catalog: "refresh-required",
      kind: "saved",
    });
  });

  it("serializes a save behind a running observation so stale facts never land last", async () => {
    const root = await makeRoot({ "README.md": "first" });
    const store = new InMemoryWorkspaceStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const slowScan: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile: async (path) => {
        // Hold the first scan's read open: it has observed the pre-save
        // directory and now waits, exactly the interleaving that would
        // restore pre-write facts if the save could slip past it.
        if (!held) {
          held = true;
          await gate;
        }
        return nodeFileSystem.readFile(path);
      },
    };
    const setup = directorySystem({ store });
    const registered = await setup.load({ path: root });
    const file = one(await registered.files());

    // Two instances of one id over one system: they must share the chain.
    const system = directorySystem({ filesystem: slowScan, store });
    const observation = (await system.open(registered.id)).refresh();
    const save = (await system.open(registered.id)).save({
      expectedDigest: digestOf("first"),
      fileId: file.id,
      text: "second",
    });

    release?.();
    await observation;
    const result = await save;

    expect(result).toMatchObject({ catalog: "current", kind: "saved" });
    expect(one(await store.listEntries(registered.id))).toMatchObject({
      digest: digestOf("second"),
    });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("second");
  });
});

describe("nodeFileSystem.replaceFile", () => {
  it("replaces bytes exactly and preserves the existing permission bits", async () => {
    const root = await makeRoot({ "mode.txt": "before" });
    const target = join(root, "mode.txt");
    await chmod(target, 0o600);

    await nodeFileSystem.replaceFile(target, new TextEncoder().encode("after"));

    expect(await readFile(target, "utf8")).toBe("after");
    // biome-ignore lint/suspicious/noBitwiseOperators: Filesystem permissions are a bit mask.
    expect((await lstat(target)).mode & 0o7777).toBe(0o600);
    expect(await readdir(root)).toEqual(["mode.txt"]);
  });

  it("throws for a missing target and creates nothing", async () => {
    const root = await makeRoot({});

    await expect(
      nodeFileSystem.replaceFile(
        join(root, "absent.txt"),
        new TextEncoder().encode("x")
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([]);
  });

  it("leaves the original bytes and no temp file when the directory refuses the write", async () => {
    const root = await makeRoot({ "locked/inner.txt": "original" });
    const dir = join(root, "locked");
    await chmod(dir, 0o500);

    try {
      await expect(
        nodeFileSystem.replaceFile(
          join(dir, "inner.txt"),
          new TextEncoder().encode("draft")
        )
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(await readFile(join(dir, "inner.txt"), "utf8")).toBe("original");
      expect(await readdir(dir)).toEqual(["inner.txt"]);
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
