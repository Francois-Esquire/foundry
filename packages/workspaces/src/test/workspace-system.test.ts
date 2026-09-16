import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import {
  InvalidWorkspaceInputError,
  WorkspaceFileNotFoundError,
  WorkspaceNotFoundError,
  WorkspacePersistenceError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
} from "../errors";
import type { WorkspaceFileSystem } from "../filesystem";
import { nodeFileSystem, sha256Hex } from "../filesystem";
import { InMemoryWorkspaceStore } from "../in-memory-workspace-store";
import type { WorkspaceId } from "../workspace";
import type { WorkspaceStore } from "../workspace-store";
import { directorySystem } from "./helpers/directory-system";
import {
  artifactWorkspace,
  fileRecord,
  hostWorkspace,
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
  const root = await mkdtemp(join(tmpdir(), "foundry-workspace-system-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolute = join(root, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
  return await nodeFileSystem.realpath(root);
}

function systemOver(store: WorkspaceStore) {
  return directorySystem({ store });
}

function missing(): Error {
  return Object.assign(new Error("no such entry"), { code: "ENOENT" });
}

function entryStats(kind: "file" | "directory") {
  return {
    isDirectory: kind === "directory",
    isFile: kind === "file",
    isSymbolicLink: false,
  };
}

describe("add({ path })", () => {
  it("commits the Workspace and every candidate File together", async () => {
    const root = await makeRoot({
      "README.md": "hello",
      "src/app.ts": "const a = 1;\n",
    });
    const system = directorySystem();

    const workspace = await system.add({ path: root });

    expect(workspace.source).toEqual({
      kind: "host",
      path: root,
      sourceId: null,
    });
    expect(await workspace.summary()).toMatchObject({
      description: null,
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

    const first = await system.add({ path: root });

    expect((await system.add({ path: root })).id).toBe(first.id);
    expect((await system.add({ path: alias })).id).toBe(first.id);
    expect(await system.list()).toHaveLength(1);
  });

  it("resolves two concurrent adds of one root to a single durable Workspace", async () => {
    const root = await makeRoot({ "README.md": "hi" });
    const system = directorySystem();

    const [left, right] = await Promise.all([
      system.add({ path: root }),
      system.add({ path: root }),
    ]);

    expect(left.id).toBe(right.id);
    expect(await system.list()).toHaveLength(1);
  });

  it("creates nothing when the first scan fails", async () => {
    const root = await makeRoot({ "later.md": "bye", "README.md": "hi" });
    const store = new InMemoryWorkspaceStore();
    const failing: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile(path) {
        return path.endsWith("later.md")
          ? Promise.reject(new Error("EIO"))
          : nodeFileSystem.readFile(path);
      },
    };
    const system = directorySystem({ filesystem: failing, store });

    await expect(system.add({ path: root })).rejects.toBeInstanceOf(
      WorkspaceSourceUnavailableError
    );
    expect(await store.listWorkspaces()).toEqual([]);
  });

  it("refuses a selection that is not a readable directory", async () => {
    const root = await makeRoot({ "README.md": "hi" });
    const system = directorySystem();

    await expect(
      system.add({ path: join(root, "README.md") })
    ).rejects.toBeInstanceOf(InvalidWorkspaceInputError);
  });

  it("refuses a ref no registered floor names, at compile time and at runtime", async () => {
    const system = directorySystem();

    await expect(
      // @ts-expect-error -- `nope` is not a ref any registered floor accepts
      system.add({ nope: "x" })
    ).rejects.toBeInstanceOf(InvalidWorkspaceInputError);
  });
});

describe("reload", () => {
  it("serves the same catalog through a freshly constructed system", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const store = new InMemoryWorkspaceStore();
    const added = await systemOver(store).add({ path: root });

    const reloaded = await systemOver(store).open(added.id);

    expect(await reloaded.summary()).toEqual(await added.summary());
    expect((await reloaded.files()).map((f) => f.path)).toEqual(["README.md"]);
  });

  it("reports an unknown Workspace and an unowned File by identity", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem();
    const added = await system.add({ path: root });
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
    const store = new InMemoryWorkspaceStore();
    const system = directorySystem({ store });
    const added = await system.add({ path: root });
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
    const added = await directorySystem().add({ path: root });

    await expect(added.rename("   ")).rejects.toBeInstanceOf(
      InvalidWorkspaceInputError
    );
  });
});

describe("read", () => {
  it("returns current source text without changing the File row", async () => {
    const root = await makeRoot({ "README.md": "first" });
    const system = directorySystem();
    const added = await system.add({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    await writeFile(join(root, "README.md"), "second");
    const result = await added.read(file.id);

    expect(result).toEqual({
      checksum: sha256Hex(new TextEncoder().encode("second")),
      kind: "text",
      mimeType: "text/markdown",
      size: 6,
      text: "second",
    });
    const [reread] = await added.files();
    expect(reread).toEqual(file);
  });

  it("refuses to follow a symlink that replaced a known File", async () => {
    const root = await makeRoot({ "README.md": "first" });
    const outside = await mkdtemp(join(tmpdir(), "foundry-workspace-out-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "classified");
    const system = directorySystem();
    const added = await system.add({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    await rm(join(root, "README.md"));
    await symlink(join(outside, "secret.txt"), join(root, "README.md"));

    expect(await added.read(file.id)).toMatchObject({
      kind: "unreadable",
    });
  });

  it("refuses a File whose parent directory became a symlink after the scan", async () => {
    const root = await makeRoot({ "pkg/notes.md": "inside" });
    const outside = await mkdtemp(join(tmpdir(), "foundry-workspace-out-"));
    roots.push(outside);
    await mkdir(join(outside, "pkg"), { recursive: true });
    await writeFile(join(outside, "pkg", "notes.md"), "classified");
    const system = directorySystem();
    const added = await system.add({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    // Nothing about the File's own path changed — the escape is one component
    // up, which a lexical check and a final-component lstat both miss.
    await rm(join(root, "pkg"), { recursive: true });
    await symlink(join(outside, "pkg"), join(root, "pkg"), "dir");

    const result = await added.read(file.id);
    expect(result.kind).toBe("unreadable");
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it("names no absolute path in any failure reason", async () => {
    const root = await makeRoot({ "README.md": "first" });
    const unreadable: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile(path) {
        return path.endsWith("README.md")
          ? Promise.reject(
              Object.assign(
                new Error(`EACCES: permission denied, open '${path}'`),
                { code: "EACCES" }
              )
            )
          : nodeFileSystem.readFile(path);
      },
    };
    const store = new InMemoryWorkspaceStore();
    const scanned = directorySystem({ store });
    const added = await scanned.add({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    const result = await (
      await directorySystem({ filesystem: unreadable, store }).open(added.id)
    ).read(file.id);

    expect(result).toEqual({
      kind: "unreadable",
      reason: "Could not read README.md (EACCES)",
    });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("reports a File that disappeared since reconciliation as stale", async () => {
    const root = await makeRoot({ "README.md": "first" });
    const system = directorySystem();
    const added = await system.add({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    await rm(join(root, "README.md"));

    expect(await added.read(file.id)).toMatchObject({
      kind: "stale",
    });
  });

  it("reads back a File the source spells differently from its stored path", async () => {
    // Spelled by code point so the fixture cannot be silently normalized by an
    // editor: "cafe" plus a combining acute accent, which is what a macOS
    // source hands back and what a byte-exact one stores verbatim.
    const decomposed = `cafe${String.fromCodePoint(0x03_01)}.md`;
    const root = await makeRoot({ [decomposed]: "beans" });
    const system = directorySystem();
    const added = await system.add({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    // The row holds the composed spelling. On a filesystem that keeps names
    // byte-for-byte, joining the root to that spelling opens nothing — and
    // reporting a File that is plainly there as `stale` would be a lie.
    expect(file.path).toBe(decomposed.normalize("NFC"));
    expect(await added.read(file.id)).toEqual({
      checksum: sha256Hex(new TextEncoder().encode("beans")),
      kind: "text",
      mimeType: "text/markdown",
      size: 5,
      text: "beans",
    });
  });

  it("finds a File on a source that stores names byte-for-byte", async () => {
    const composed = `caf${String.fromCodePoint(0x00_e9)}.md`;
    const decomposed = `cafe${String.fromCodePoint(0x03_01)}.md`;
    const root = `/byte-exact-${crypto.randomUUID()}`;
    const store = new InMemoryWorkspaceStore();
    const registered = hostWorkspace({ path: root });
    const file = fileRecord(registered.id, { path: composed });
    await store.commitCreate({ files: [file], workspace: registered });

    // macOS looks a name up regardless of its composition, so a real temporary
    // directory cannot tell a correct resolution apart from a naive join. This
    // source answers only to the spelling it was given — which is what ext4
    // and btrfs do, and the only condition under which the fallback matters.
    const onlyDecomposed = join(root, decomposed);
    const byteExact: WorkspaceFileSystem = {
      lstat: (path) => {
        if (path === root) {
          return Promise.resolve(entryStats("directory"));
        }
        if (path === onlyDecomposed) {
          return Promise.resolve(entryStats("file"));
        }
        return Promise.reject(missing());
      },
      readDirectory: (path) =>
        path === root
          ? Promise.resolve([
              {
                isDirectory: false,
                isFile: true,
                isSymbolicLink: false,
                name: decomposed,
              },
            ])
          : Promise.reject(missing()),
      readFile: (path) =>
        path === onlyDecomposed
          ? Promise.resolve(new TextEncoder().encode("beans"))
          : Promise.reject(missing()),
      realpath: (path) =>
        path === root || path === onlyDecomposed
          ? Promise.resolve(path)
          : Promise.reject(missing()),
      replaceFile: () => Promise.reject(new Error("a read never writes")),
    };

    const workspace = await directorySystem({
      filesystem: byteExact,
      store,
    }).open(registered.id);

    expect(await workspace.read(file.id)).toEqual({
      checksum: sha256Hex(new TextEncoder().encode("beans")),
      kind: "text",
      mimeType: "text/markdown",
      size: 5,
      text: "beans",
    });
  });

  it("resolves the stored spelling without listing when it opens directly", async () => {
    const root = await makeRoot({ "docs/guide.md": "plain" });
    const listed: string[] = [];
    const watched: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readDirectory(path) {
        listed.push(path);
        return nodeFileSystem.readDirectory(path);
      },
    };
    const store = new InMemoryWorkspaceStore();
    const added = await directorySystem({ store }).add({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    const reader = await directorySystem({
      filesystem: watched,
      store,
    }).open(added.id);
    expect(await reader.read(file.id)).toMatchObject({ kind: "text" });
    // The fallback is a fallback: an ordinary ASCII path costs no listing.
    expect(listed).toEqual([]);
  });

  it("separates a Workspace whose source is gone from one missing File", async () => {
    const root = await makeRoot({ "other.md": "second", "README.md": "first" });
    const system = directorySystem();
    const added = await system.add({ path: root });
    const [first, second] = await added.files();
    if (!(first && second)) {
      throw new Error("expected two Files");
    }

    await rm(join(root, "other.md"));
    const missingFile = await added.read(second.id);
    await rm(root, { recursive: true });
    const unavailable = await added.read(first.id);

    expect(missingFile).toMatchObject({ kind: "stale" });
    expect(unavailable).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(unavailable)).not.toContain(root);
  });

  it("reports bytes that are not valid UTF-8 as binary without a NUL to warn it", async () => {
    const root = await makeRoot({});
    // A truncated two-byte sequence: nothing here is a NUL, so only strict
    // decoding can tell this apart from text. Lenient decoding would hand back
    // a replacement character and call it content.
    await writeFile(join(root, "broken.txt"), Buffer.from([0xc3, 0x28]));
    const system = directorySystem();
    const added = await system.add({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    expect(await added.read(file.id)).toEqual({
      checksum: sha256Hex(new Uint8Array([0xc3, 0x28])),
      kind: "binary",
      mimeType: "text/plain",
      size: 2,
    });
  });

  it("reports undecodable bytes as binary rather than corrupting them", async () => {
    const root = await makeRoot({});
    await writeFile(join(root, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 1]));
    const system = directorySystem();
    const added = await system.add({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    expect(await added.read(file.id)).toEqual({
      checksum: sha256Hex(new Uint8Array([0xff, 0xfe, 0x00, 1])),
      kind: "binary",
      mimeType: null,
      size: 4,
    });
  });
});

describe("reconciliation", () => {
  async function opened(tree: Record<string, string>) {
    const root = await makeRoot(tree);
    const store = new InMemoryWorkspaceStore();
    const system = systemOver(store);
    const added = await system.add({ path: root });
    const files = await added.files();
    return { added, files, id: added.id, root, store, system };
  }

  function idsByPath(files: readonly { path: string; id: string }[]) {
    return Object.fromEntries(files.map((file) => [file.path, file.id]));
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
    expect(view.files.map((file) => file.path)).toEqual([
      "README.md",
      "added.md",
    ]);
    const after = idsByPath(view.files);
    expect(after["README.md"]).toBe(before["README.md"]);
    expect(Object.values(after)).not.toContain(before["drop.md"]);
    expect(view.files[0]?.size).toBe(6);
  });

  it("leaves an untouched catalog byte-for-byte identical", async () => {
    const { added, files } = await opened({ "README.md": "first" });

    const view = await added.refresh();

    expect(view.files).toEqual(files);
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

    expect(view.files.map((file) => file.path)).toEqual(["docs/notes.md"]);
    expect(view.files[0]?.id).toBe(files[0]?.id);
    expect(view.files[0]?.createdAt).toEqual(files[0]?.createdAt);
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

    expect(view.files.map((file) => file.path)).toEqual([
      "moved/a.md",
      "moved/b.md",
    ]);
    for (const file of view.files) {
      expect(before.has(file.id)).toBe(false);
    }
  });

  it("deletes rows a new nested ignore rule excludes", async () => {
    const { root, added } = await opened({
      "pkg/keep.ts": "1",
      "pkg/local.json": "{}",
    });

    await writeFile(join(root, "pkg", ".gitignore"), "local.json\n");

    expect((await added.refresh()).files.map((file) => file.path)).toEqual([
      "pkg/.gitignore",
      "pkg/keep.ts",
    ]);
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
    expect(view.files).toEqual(files);
    expect(await added.files()).toEqual(files);
  });

  it("reports an unavailable root beside the catalog it still knows", async () => {
    const { root, added, files } = await opened({ "README.md": "hi" });

    await rm(root, { recursive: true });
    const view = await added.refresh();

    expect(view.source).toMatchObject({ kind: "unavailable" });
    expect(view.files).toEqual(files);
    expect(JSON.stringify(view)).not.toContain(root);
  });

  it("never matches a move across Workspace ownership", async () => {
    const store = new InMemoryWorkspaceStore();
    const system = systemOver(store);
    const left = await makeRoot({ "twin.md": "identical bytes" });
    const right = await makeRoot({ "other.md": "unrelated" });
    const leftWorkspace = await system.add({ path: left });
    const rightWorkspace = await system.add({ path: right });
    const [leftFile] = await leftWorkspace.files();

    // The right Workspace gains a File with the left's exact fingerprint while
    // the left loses nothing. A fingerprint index that ignored ownership would
    // hand the left's id to the right's new File.
    await writeFile(join(right, "twin.md"), "identical bytes");

    const view = await rightWorkspace.refresh();

    expect(view.files.map((file) => file.id)).not.toContain(leftFile?.id);
    expect((await leftWorkspace.files())[0]).toEqual(leftFile);
  });

  it("reconciles an add of a root that is already registered", async () => {
    const { root, system, id, files } = await opened({ "README.md": "first" });
    await writeFile(join(root, "second.md"), "more");

    const again = await system.add({ path: root });

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
      realpath: refusing("realpath"),
      replaceFile: refusing("replaceFile"),
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
    expect((await offline.list()).map((w) => w.id)).toEqual([id]);
    expect(reached).toEqual([]);
  });

  it("joins two overlapping observations instead of scanning twice", async () => {
    const { root, store, id } = await opened({ "README.md": "first" });
    await writeFile(join(root, "second.md"), "more");
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
    const system = directorySystem({ filesystem: counted, store });

    // Two independent observations of one source would each decide `second.md`
    // is missing and each mint an id for it; whichever commits second collides
    // on the unique path and raises a persistence exception for what is an
    // ordinary refresh. The second caller joins the first observation instead
    // — through two separate instances of the same id, since the guard is the
    // system's, not the instance's.
    const [left, right] = await Promise.all([
      (await system.open(id)).refresh(),
      (await system.open(id)).refresh(),
    ]);

    expect(scans).toBe(1);
    expect(left.files.map((file) => file.id)).toEqual(
      right.files.map((file) => file.id)
    );
    expect((await store.listFiles(id)).map((file) => file.path)).toEqual([
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
    expect(second.files.map((file) => file.path)).toEqual([
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
      directorySystem({ filesystem: failing, store }).add({ path: root })
    ).rejects.toBeInstanceOf(WorkspaceSourceUnavailableError);
    expect(await store.listFiles(id)).toEqual(
      files.map((file) => ({ ...file, workspaceId: id }))
    );
  });

  it("keeps the prior catalog when the store rejects the commit", async () => {
    const { root, store, id, files } = await opened({ "README.md": "first" });
    await writeFile(join(root, "second.md"), "more");
    const refusing: WorkspaceStore = {
      commitCreate: (input) => store.commitCreate(input),
      commitFileObservation: (input) => store.commitFileObservation(input),
      commitReconcile: () =>
        Promise.resolve({ kind: "conflict", reason: "injected" }),
      countFiles: (workspaceId) => store.countFiles(workspaceId),
      findWorkspaceByPath: (path) => store.findWorkspaceByPath(path),
      getFile: (workspaceId, fileId) => store.getFile(workspaceId, fileId),
      getWorkspace: (workspaceId) => store.getWorkspace(workspaceId),
      listFiles: (workspaceId) => store.listFiles(workspaceId),
      listWorkspaces: () => store.listWorkspaces(),
      removeWorkspace: (workspaceId) => store.removeWorkspace(workspaceId),
      renameWorkspace: (workspaceId, name, updatedAt) =>
        store.renameWorkspace(workspaceId, name, updatedAt),
    };

    const failure = await directorySystem({ store: refusing })
      .open(id)
      .then((workspace) => workspace.refresh())
      .then(
        () => null,
        (error: unknown) => error as Error
      );

    expect(failure).toBeInstanceOf(WorkspacePersistenceError);
    // The store's reason is the driver's own message, which for SQLite embeds
    // the absolute database path. It travels as a cause, never as text that
    // could be shown.
    expect(failure?.message).not.toContain("injected");
    expect((failure as { cause?: unknown } | null)?.cause).toBe("injected");
    expect((await store.listFiles(id)).map((file) => file.path)).toEqual(
      files.map((file) => file.path)
    );
    expect((await store.listFiles(id)).map((file) => file.id)).toEqual(
      files.map((file) => file.id)
    );
  });
});

describe("remove", () => {
  it("deletes the rows and leaves every source File in place", async () => {
    const root = await makeRoot({ "README.md": "hi", "src/app.ts": "1" });
    const system = directorySystem();
    const added = await system.add({ path: root });

    await added.remove();

    expect(await system.list()).toEqual([]);
    await expect(system.open(added.id)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("hi");
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe("1");
  });

  it("removes a Workspace whose source is gone and reports a second removal", async () => {
    const root = await makeRoot({ "README.md": "hi" });
    const system = directorySystem();
    const added = await system.add({ path: root });
    await rm(root, { recursive: true });

    await added.remove();

    await expect(added.remove()).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});

describe("published contracts", () => {
  it("carries the source kind as a label and never a root or reference", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem();
    const added = await system.add({ path: root });
    const summary = await added.summary();
    const files = await added.files();

    const serialized = JSON.stringify({ files, summary });

    expect(summary.sourceKind).toBe("host");
    expect(Object.keys(summary)).not.toContain("path");
    expect(Object.keys(summary)).not.toContain("sourceId");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toMatch(/folder|content|project|analysis/i);
    expect(files[0] && Object.keys(files[0])).not.toContain("content");
  });
});

/**
 * The system owns the instance lifecycle: one live instance per id, layers
 * composed at open, hooks run by the system alone.
 */
describe("lifecycle", () => {
  it("opens one instance per id and shares it until closed", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem();
    const added = await system.add({ path: root });

    expect(await system.open(added.id)).toBe(added);
    expect((await system.list())[0]).toBe(added);

    await system.close(added.id);
    const reopened = await system.open(added.id);
    expect(reopened).not.toBe(added);
    expect(reopened.id).toBe(added.id);
  });

  it("runs start once at open and stop once at close, through the chain", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const events: string[] = [];
    const system = directorySystem().extend({
      applies: () => true,
      name: "probe",
      wrap: (Base) =>
        class extends Base {
          protected override async start() {
            await super.start();
            events.push("start");
          }
          protected override async stop() {
            events.push("stop");
            await super.stop();
          }
        },
    });

    const added = await system.add({ path: root });
    await system.open(added.id);
    expect(events).toEqual(["start"]);

    await system.closeAll();
    expect(events).toEqual(["start", "stop"]);
    expect(await system.open(added.id)).not.toBe(added);
  });

  it("evicts a removed Workspace so a later open refuses it", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem();
    const added = await system.add({ path: root });

    await added.remove();

    await expect(system.open(added.id)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
  });

  it("refuses a stored source no registered layer claims, by name", async () => {
    const store = new InMemoryWorkspaceStore();
    const record = artifactWorkspace(
      crypto.randomUUID(),
      "foundry://abc.artifact"
    );
    await store.commitCreate({ files: [], workspace: record });
    const system = directorySystem({ store });

    await expect(system.open(record.id)).rejects.toThrow(
      new WorkspaceSourceUnsupportedError("artifact")
    );
    // Nothing is cached for a failed open.
    await expect(system.open(record.id)).rejects.toBeInstanceOf(
      WorkspaceSourceUnsupportedError
    );
  });

  it("composes layers in registration order and lets a later layer see the earlier one", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem().extend({
      applies: (record) => record.source === "host",
      name: "labelled",
      wrap: (Base) =>
        class extends Base {
          readonly label = `dir:${this.source.path}`;
        },
    });

    const added = await system.add({ path: root });

    expect(added).toHaveProperty("label", `dir:${root}`);
    expect(added).toHaveProperty("root", root);
  });
});
