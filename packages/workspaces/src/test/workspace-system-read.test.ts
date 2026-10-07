import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryWorkspaceStore } from "../memory-store";
import { nodeFileSystem } from "../node";
import type { WorkspaceFileSystem } from "../types";
import { sha256Hex } from "./helpers/digest";

import { directorySystem } from "./helpers/directory-system";
import { fileRecord, hostWorkspace, seed } from "./helpers/fixtures";
import { makeRoot, roots } from "./helpers/temp-roots";

function missing(): Error {
  return Object.assign(new Error("no such entry"), { code: "ENOENT" });
}

function entryStats(kind: "file" | "directory") {
  return {
    type: kind,
  };
}

describe("read", () => {
  it("returns current source text without changing the File row", async () => {
    const root = await makeRoot({ "README.md": "first" });
    const system = directorySystem();
    const added = await system.load({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    await writeFile(join(root, "README.md"), "second");
    const result = await added.read(file.id);

    expect(result).toEqual({
      bytes: 6,
      digest: sha256Hex(new TextEncoder().encode("second")),
      kind: "text",
      mime: "text/markdown",
      text: "second",
      type: "file" as const,
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
    const added = await system.load({ path: root });
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
    const added = await system.load({ path: root });
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
    const store = new MemoryWorkspaceStore();
    const scanned = directorySystem({ store });
    const added = await scanned.load({ path: root });
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
    const added = await system.load({ path: root });
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
    const added = await system.load({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    // The row holds the composed spelling. On a filesystem that keeps names
    // byte-for-byte, joining the root to that spelling opens nothing — and
    // reporting a File that is plainly there as `stale` would be a lie.
    expect(file.path).toBe(decomposed.normalize("NFC"));
    expect(await added.read(file.id)).toEqual({
      bytes: 5,
      digest: sha256Hex(new TextEncoder().encode("beans")),
      kind: "text",
      mime: "text/markdown",
      text: "beans",
      type: "file" as const,
    });
  });

  it("finds a File on a source that stores names byte-for-byte", async () => {
    const composed = `caf${String.fromCodePoint(0x00_e9)}.md`;
    const decomposed = `cafe${String.fromCodePoint(0x03_01)}.md`;
    const root = `/byte-exact-${crypto.randomUUID()}`;
    const store = new MemoryWorkspaceStore();
    const registered = hostWorkspace({ path: root });
    const file = fileRecord(registered.id, { path: composed });
    await seed(store, registered, [file]);

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
                name: decomposed,
                type: "file",
              },
            ])
          : Promise.reject(missing()),
      readFile: (path) =>
        path === onlyDecomposed
          ? Promise.resolve(new TextEncoder().encode("beans"))
          : Promise.reject(missing()),
      readLink: (path) => nodeFileSystem.readLink(path),
      realpath: (path) =>
        path === root || path === onlyDecomposed
          ? Promise.resolve(path)
          : Promise.reject(missing()),
      replaceFile: () => Promise.reject(new Error("a read never writes")),
      separator: nodeFileSystem.separator,
    };

    const workspace = await directorySystem({
      filesystem: byteExact,
      store,
    }).open(registered.id);

    expect(await workspace.read(file.id)).toEqual({
      bytes: 5,
      digest: sha256Hex(new TextEncoder().encode("beans")),
      kind: "text",
      mime: "text/markdown",
      text: "beans",
      type: "file" as const,
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
    const store = new MemoryWorkspaceStore();
    const added = await directorySystem({ store }).load({ path: root });
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
    const added = await system.load({ path: root });
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
    const added = await system.load({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    expect(await added.read(file.id)).toEqual({
      bytes: 2,
      digest: sha256Hex(new Uint8Array([0xc3, 0x28])),
      kind: "binary",
      mime: "text/plain",
      type: "file" as const,
    });
  });

  it("reports undecodable bytes as binary rather than corrupting them", async () => {
    const root = await makeRoot({});
    await writeFile(join(root, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 1]));
    const system = directorySystem();
    const added = await system.load({ path: root });
    const [file] = await added.files();
    if (!file) {
      throw new Error("expected one File");
    }

    expect(await added.read(file.id)).toEqual({
      bytes: 4,
      digest: sha256Hex(new Uint8Array([0xff, 0xfe, 0x00, 1])),
      kind: "binary",
      mime: null,
      type: "file" as const,
    });
  });
});
