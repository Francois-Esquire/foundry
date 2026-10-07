import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageReader } from "@foundry/core/storage";
import { normalizeStoragePath } from "@foundry/lib/paths";
import { afterAll, describe, expect, it } from "vitest";
import {
  InvalidWorkspaceInputError,
  WorkspaceSourceUnavailableError,
} from "../errors";
import { nodeFileSystem } from "../node";
import { canonicalizeRoot, scanDirectory, verifyRoot } from "../scanner";
import { walkEntries } from "../traverse";
import type { WorkspaceFileSystem } from "../types";
import { sha256Hex } from "./helpers/digest";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function makeRoot(
  tree: Record<string, string>
): Promise<{ root: string; canonical: string }> {
  const root = await mkdtemp(join(tmpdir(), "foundry-workspace-scan-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolute = join(root, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
  return { canonical: await canonicalizeRoot(nodeFileSystem, root), root };
}

function entry(name: string) {
  return { name, type: "file" as const };
}

describe("canonicalizeRoot", () => {
  it("resolves a symlinked spelling to the same canonical root", async () => {
    const { root, canonical } = await makeRoot({ "README.md": "hi" });
    const linkParent = await mkdtemp(join(tmpdir(), "foundry-workspace-link-"));
    roots.push(linkParent);
    const link = join(linkParent, "alias");
    await symlink(root, link, "dir");

    expect(await canonicalizeRoot(nodeFileSystem, link)).toBe(canonical);
  });

  it("refuses a file and a path that does not resolve", async () => {
    const { root } = await makeRoot({ "README.md": "hi" });

    await expect(
      canonicalizeRoot(nodeFileSystem, join(root, "README.md"))
    ).rejects.toBeInstanceOf(InvalidWorkspaceInputError);
    await expect(
      canonicalizeRoot(nodeFileSystem, join(root, "absent"))
    ).rejects.toBeInstanceOf(InvalidWorkspaceInputError);
  });

  it("echoes no absolute path in its refusal messages", async () => {
    const { root } = await makeRoot({ "README.md": "hi" });

    // These messages reach callers outside the trust boundary, so the selected
    // root would leak through them.
    for (const selected of [join(root, "README.md"), join(root, "absent")]) {
      const failure = await canonicalizeRoot(nodeFileSystem, selected).then(
        () => null,
        (error: unknown) => error as Error
      );
      expect(failure?.message).not.toContain(root);
    }
  });
});

describe("scanDirectory inclusion", () => {
  it("catalogs special entries without opening them or resolving symlink targets", async () => {
    const filesystem: StorageReader = {
      lstat: () => Promise.resolve({ type: "directory" }),
      readDirectory: () =>
        Promise.resolve([
          { name: "socket", type: "socket" },
          { name: "device", type: "device" },
          { name: "pipe", type: "pipe" },
          { name: "link", type: "symlink" },
          { name: "unsupported", type: "unknown" },
        ]),
      readFile: () =>
        Promise.reject(new Error("Special entries must not be opened")),
      readLink: (path) => {
        expect(path).toBe("/root/link");
        return Promise.resolve("../missing\n");
      },
      realpath: (path) => {
        expect(path).toBe("/root");
        return Promise.resolve(path);
      },
      separator: "/",
    };
    expect(await scanDirectory(filesystem, "/root")).toEqual([
      { name: "device", path: "device", type: "device" },
      { name: "link", path: "link", target: "../missing\n", type: "symlink" },
      { name: "pipe", path: "pipe", type: "pipe" },
      { name: "socket", path: "socket", type: "socket" },
    ]);
  });

  it("scans through read-only capabilities without requiring writes", async () => {
    const { root, canonical } = await makeRoot({ "README.md": "hello" });
    const inspector = {
      lstat: (path: string) => nodeFileSystem.lstat(path),
      readLink: (path: string) => nodeFileSystem.readLink(path),
      realpath: (path: string) => nodeFileSystem.realpath(path),
    };
    const reader = {
      readDirectory: (path: string) => nodeFileSystem.readDirectory(path),
      readFile: (path: string) => nodeFileSystem.readFile(path),
      separator: nodeFileSystem.separator,
    };
    const filesystem: StorageReader = { ...inspector, ...reader };

    expect(await canonicalizeRoot(inspector, root)).toBe(canonical);
    await verifyRoot(inspector, canonical);
    expect(await walkEntries(reader, canonical)).toEqual([
      {
        absolutePath: join(canonical, "README.md"),
        relativePath: "README.md",
        type: "file",
      },
    ]);
    expect(await scanDirectory(filesystem, canonical)).toEqual([
      {
        bytes: 5,
        digest: sha256Hex(new TextEncoder().encode("hello")),
        extension: "md",
        kind: "document",
        mime: "text/markdown",
        name: "README.md",
        path: "README.md",
        type: "file" as const,
      },
    ]);
  });

  it("catalogs files, parent directories, and empty directories", async () => {
    const { canonical } = await makeRoot({
      "README.md": "hello",
      "src/app.ts": "export const a = 1;\n",
      "src/deep/notes.unknownext": "raw",
    });
    await mkdir(join(canonical, "empty"), { recursive: true });

    const candidates = await scanDirectory(nodeFileSystem, canonical);

    expect(candidates.map((c) => c.path)).toEqual([
      "README.md",
      "empty",
      "src",
      "src/app.ts",
      "src/deep",
      "src/deep/notes.unknownext",
    ]);
    expect(candidates[0]).toEqual({
      bytes: 5,
      digest: sha256Hex(new TextEncoder().encode("hello")),
      extension: "md",
      kind: "document",
      mime: "text/markdown",
      name: "README.md",
      path: "README.md",
      type: "file" as const,
    });
    expect(
      candidates.find(
        (candidate) => candidate.path === "src/deep/notes.unknownext"
      )
    ).toMatchObject({
      extension: "unknownext",
      kind: "other",
      mime: null,
    });
  });

  it("excludes the versioned baseline set", async () => {
    const { canonical } = await makeRoot({
      ".DS_Store": "junk",
      ".git/HEAD": "ref",
      "node_modules/left-pad/index.js": "module.exports = 1;",
      "README.md": "hi",
    });

    expect(
      (await scanDirectory(nodeFileSystem, canonical)).map((c) => c.path)
    ).toEqual(["README.md"]);
  });

  it("applies root and nested gitignore rules", async () => {
    const { canonical } = await makeRoot({
      ".gitignore": "*.log\nbuild/\n",
      "app.log": "noise",
      "build/out.js": "built",
      "keep.ts": "1",
      "pkg/.gitignore": "local.json\n",
      "pkg/local.json": "{}",
      "pkg/nested/local.json": "{}",
      "pkg/shared.json": "{}",
    });

    expect(
      (await scanDirectory(nodeFileSystem, canonical)).map((c) => c.path)
    ).toEqual([
      ".gitignore",
      "keep.ts",
      "pkg",
      "pkg/.gitignore",
      "pkg/nested",
      "pkg/shared.json",
    ]);
  });

  it("lets a nested negation re-include what a parent excluded", async () => {
    const { canonical } = await makeRoot({
      ".gitignore": "*.log\n",
      "pkg/.gitignore": "!keep.log\n",
      "pkg/keep.log": "wanted",
      "pkg/other.log": "noise",
      "root.log": "noise",
    });

    // Git gives the deepest `.gitignore` that speaks the last word. Or-ing the
    // scope stack together would make `!keep.log` unreachable.
    expect(
      (await scanDirectory(nodeFileSystem, canonical)).map((c) => c.path)
    ).toEqual([".gitignore", "pkg", "pkg/.gitignore", "pkg/keep.log"]);
  });

  it("anchors a leading-slash rule to its own declaring directory", async () => {
    const { canonical } = await makeRoot({
      "pkg/.gitignore": "/local.json\n",
      "pkg/local.json": "{}",
      "pkg/sub/local.json": "{}",
    });

    // Git reads `/local.json` as "in this directory only". An unanchored
    // `local.json` would take the nested copy with it.
    expect(
      (await scanDirectory(nodeFileSystem, canonical)).map((c) => c.path)
    ).toEqual(["pkg", "pkg/.gitignore", "pkg/sub", "pkg/sub/local.json"]);
  });

  it("keeps a nested rule from leaking into a sibling subtree", async () => {
    const { canonical } = await makeRoot({
      "left/.gitignore": "secret.txt\n",
      "left/secret.txt": "x",
      "right/secret.txt": "x",
    });

    expect(
      (await scanDirectory(nodeFileSystem, canonical)).map((c) => c.path)
    ).toEqual(["left", "left/.gitignore", "right", "right/secret.txt"]);
  });
});

describe("scanDirectory determinism", () => {
  it("sorts the complete candidate list by normalized path", async () => {
    const { canonical } = await makeRoot({
      "a/a.txt": "4",
      "a/z.txt": "3",
      "src.md": "2",
      "src/app.ts": "1",
    });

    // Walk order would emit `src/app.ts` before `src.md`, because `src` sorts
    // before `src.md` as a directory entry. The candidate list is one ordering
    // for both stores and the diff, so it is sorted by path instead.
    expect(
      (await scanDirectory(nodeFileSystem, canonical)).map((c) => c.path)
    ).toEqual(["a", "a/a.txt", "a/z.txt", "src", "src.md", "src/app.ts"]);
  });

  it("composes a decomposed source name and still reads its raw bytes", async () => {
    const decomposed = "café.md";
    const { canonical } = await makeRoot({ [decomposed]: "beans" });

    const [candidate] = await scanDirectory(nodeFileSystem, canonical);

    expect(candidate?.path).toBe("café.md");
    expect(candidate?.name).toBe("café.md");
    expect(candidate).toMatchObject({ bytes: 5 });
  });

  it("refuses a scan whose entries normalize onto one path", async () => {
    // Two spellings one composition-insensitive filesystem would never hold at
    // once, and one that does would hand to two File rows in memory and one in
    // SQLite.
    const colliding: WorkspaceFileSystem = {
      lstat: () =>
        Promise.resolve({
          type: "directory",
        }),
      readDirectory: () =>
        Promise.resolve([entry("café.md"), entry("café.md")]),
      readFile: () => Promise.resolve(new TextEncoder().encode("x")),
      readLink: () => Promise.reject(new Error("not a link")),
      realpath: (path) => Promise.resolve(path),
      replaceFile: () => Promise.reject(new Error("a scan never writes")),
      separator: "/",
    };

    await expect(scanDirectory(colliding, "/root")).rejects.toBeInstanceOf(
      WorkspaceSourceUnavailableError
    );
  });

  it("takes each digest and bytes from one opened byte sequence", async () => {
    const { canonical } = await makeRoot({ "README.md": "hello" });
    const statted: string[] = [];
    const watched: WorkspaceFileSystem = {
      ...nodeFileSystem,
      lstat(path) {
        statted.push(path);
        return nodeFileSystem.lstat(path);
      },
    };

    const [candidate] = await scanDirectory(watched, canonical);

    expect(candidate).toMatchObject({
      digest: sha256Hex(new TextEncoder().encode("hello")),
    });
    expect(candidate).toMatchObject({ bytes: 5 });
    expect(statted).toEqual([canonical]);
  });
});

describe("verifyRoot", () => {
  it("reports a root that disappeared as an unavailable source", async () => {
    const { canonical } = await makeRoot({ "README.md": "hi" });
    await rm(canonical, { recursive: true });

    const failure = await scanDirectory(nodeFileSystem, canonical).then(
      () => null,
      (error: unknown) => error as WorkspaceSourceUnavailableError
    );

    expect(failure).toBeInstanceOf(WorkspaceSourceUnavailableError);
    expect(failure?.issue).toBe("unavailable");
    expect(failure?.message).not.toContain(canonical);
  });

  it("reports a root replaced by a file as an unavailable source", async () => {
    const { canonical } = await makeRoot({ "README.md": "hi" });
    await rm(canonical, { recursive: true });
    await writeFile(canonical, "not a directory");

    await expect(verifyRoot(nodeFileSystem, canonical)).rejects.toMatchObject({
      issue: "unavailable",
    });
  });

  it("classifies a root that refuses to be read the same way a subdirectory is", async () => {
    const { canonical } = await makeRoot({ "README.md": "hi" });
    const refusing: WorkspaceFileSystem = {
      ...nodeFileSystem,
      lstat(path) {
        return path === canonical
          ? Promise.reject(
              Object.assign(new Error("denied"), { code: "EACCES" })
            )
          : nodeFileSystem.lstat(path);
      },
    };

    // The same errno one directory deeper produces `unreadable`. Flattening
    // every root failure to `unavailable` would tell a person their directory
    // is gone when it is only locked.
    await expect(verifyRoot(refusing, canonical)).rejects.toMatchObject({
      issue: "unreadable",
    });
  });

  it("names a refused read unreadable and any other break a scan failure", async () => {
    const { canonical } = await makeRoot({ "a.md": "one", "b.md": "two" });
    const refusing: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile(path) {
        return path.endsWith("b.md")
          ? Promise.reject(
              Object.assign(new Error("denied"), { code: "EACCES" })
            )
          : nodeFileSystem.readFile(path);
      },
    };
    const broken: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile(path) {
        return path.endsWith("b.md")
          ? Promise.reject(Object.assign(new Error("io"), { code: "EIO" }))
          : nodeFileSystem.readFile(path);
      },
    };

    await expect(scanDirectory(refusing, canonical)).rejects.toMatchObject({
      issue: "unreadable",
    });
    await expect(scanDirectory(broken, canonical)).rejects.toMatchObject({
      issue: "scan-failed",
    });
  });
});

describe("scanDirectory confinement", () => {
  it("never reads through a file or directory symlink", async () => {
    const { canonical } = await makeRoot({ "README.md": "hi" });
    const outside = await mkdtemp(join(tmpdir(), "foundry-workspace-out-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "classified");
    await symlink(outside, join(canonical, "escape"), "dir");
    await symlink(join(outside, "secret.txt"), join(canonical, "leak.txt"));

    const read: string[] = [];
    const watched: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile(path) {
        read.push(path);
        return nodeFileSystem.readFile(path);
      },
    };

    expect(
      (await scanDirectory(watched, canonical)).map((c) => [c.path, c.type])
    ).toEqual([
      ["README.md", "file"],
      ["escape", "symlink"],
      ["leak.txt", "symlink"],
    ]);
    expect(read.some((path) => path.includes(outside))).toBe(false);
  });

  it("returns no partial inventory when a read fails after earlier entries", async () => {
    const { canonical } = await makeRoot({
      "a.md": "first",
      "b.md": "second",
      "c.md": "third",
    });

    const read: string[] = [];
    const failing: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readFile(path) {
        read.push(path);
        if (path.endsWith("b.md")) {
          return Promise.reject(new Error("EIO"));
        }
        return nodeFileSystem.readFile(path);
      },
    };

    await expect(scanDirectory(failing, canonical)).rejects.toBeInstanceOf(
      WorkspaceSourceUnavailableError
    );
    expect(read.some((path) => path.endsWith("a.md"))).toBe(true);
  });

  it("aborts rather than skipping a directory it cannot enumerate", async () => {
    const { canonical } = await makeRoot({
      "keep.md": "kept",
      "locked/inside.md": "hidden",
    });

    const failing: WorkspaceFileSystem = {
      ...nodeFileSystem,
      readDirectory(path) {
        if (path.endsWith("locked")) {
          return Promise.reject(new Error("EACCES"));
        }
        return nodeFileSystem.readDirectory(path);
      },
    };

    await expect(walkEntries(failing, canonical)).rejects.toBeInstanceOf(
      WorkspaceSourceUnavailableError
    );
  });
});

describe("traversal vocabulary", () => {
  it("normalizes a relative path to POSIX form", () => {
    expect(normalizeStoragePath("./src/app.ts")).toBe("src/app.ts");
    expect(normalizeStoragePath("src/deep/")).toBe("src/deep");
  });
});
