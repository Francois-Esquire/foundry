import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageChecks } from "@foundry/core/testing/storage";
import { afterEach, describe, expect, it } from "vitest";

import { guestStorage } from "../container/storage";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "container-storage-"))
  );
  roots.push(root);
  await mkdir(join(root, "nested"));
  await mkdir(join(root, "empty"));
  await writeFile(join(root, "kept.txt"), "original", { mode: 0o640 });
  await writeFile(join(root, "nested/value.txt"), "nested");
  await symlink("kept.txt", join(root, "link"));
  let failReplacement = false;
  let failDirectoryRead = false;
  const storage = guestStorage(
    {
      async list(path) {
        if (failDirectoryRead) {
          failDirectoryRead = false;
          throw new Error("directory observation failed");
        }
        return Promise.all(
          (await readdir(path, { withFileTypes: true })).map(async (entry) => ({
            kind: entryKind(entry),
            mode: (await lstat(join(path, entry.name))).mode,
            path: join(path, entry.name),
          }))
        );
      },
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      read: readFile,
      remove: unlink,
      async rename(from, to) {
        if (failReplacement) {
          failReplacement = false;
          throw new Error("replacement failed");
        }
        await rename(from, to);
      },
      async stat(path) {
        const info = await stat(path);
        return {
          kind: info.isDirectory() ? "directory" : "file",
          mode: info.mode,
        };
      },
      write: (path, bytes) => writeFile(path, bytes),
    },
    async (argv) => {
      const [, , , path] = argv;
      if (!path) {
        throw new Error("Expected a guest path argument");
      }
      if (argv[0] === "readlink") {
        if (argv[1] === "-z") {
          expect(argv.slice(0, 3)).toEqual(["readlink", "-z", "--"]);
          return {
            exitCode: 0,
            stderr: "",
            stdout: `${await readlink(path)}\0`,
          };
        }
        expect(argv.slice(0, 3)).toEqual(["readlink", "-ez", "--"]);
        return { exitCode: 0, stderr: "", stdout: `${await realpath(path)}\0` };
      }
      expect(argv[0]).toBe("chmod");
      await chmod(path, Number.parseInt(argv[1] ?? "", 8));
      return { exitCode: 0, stderr: "", stdout: "" };
    }
  );
  return {
    failNextDirectoryRead() {
      failDirectoryRead = true;
    },
    failNextReplacement() {
      failReplacement = true;
    },
    root,
    storage,
  };
}

describe("guest storage SDK adapter", () => {
  it("classifies SDK special entries by mode without opening them", async () => {
    const unexpected = () =>
      Promise.reject(new Error("Unexpected file operation"));
    const storage = guestStorage(
      {
        list: () =>
          Promise.resolve([
            { kind: "other", mode: 0o14_0600, path: "/socket" },
            { kind: "other", mode: 0o01_0600, path: "/pipe" },
            { kind: "other", mode: 0o06_0600, path: "/block" },
            { kind: "other", mode: 0o02_0600, path: "/char" },
            { kind: "other", mode: 0, path: "/unknown" },
          ]),
        mkdir: unexpected,
        read: unexpected,
        remove: unexpected,
        rename: unexpected,
        stat: unexpected,
        write: unexpected,
      },
      unexpected
    );
    expect(await storage.readDirectory("/")).toEqual([
      { name: "socket", type: "socket" },
      { name: "pipe", type: "pipe" },
      { name: "block", type: "device" },
      { name: "char", type: "device" },
      { name: "unknown", type: "unknown" },
    ]);
    expect(await storage.lstat("/pipe")).toEqual({ type: "pipe" });
  });

  it("preserves dangling link targets and trailing newlines", async () => {
    const { root, storage } = await fixture();
    await symlink("../missing\n", join(root, "dangling"));
    expect(await storage.readLink(join(root, "dangling"))).toBe("../missing\n");
    expect(await storage.lstat(join(root, "dangling"))).toEqual({
      type: "symlink",
    });
  });

  for (const check of storageChecks) {
    it(check.name, async () => {
      await check.run(await fixture());
    });
  }

  it("preserves permissions and paths ending in a newline", async () => {
    const { root, storage } = await fixture();
    const path = join(root, "line\n");
    await writeFile(path, "original", { mode: 0o640 });
    expect(await storage.realpath(path)).toBe(path);
    await storage.replaceFile(path, new TextEncoder().encode("saved"));
    // biome-ignore lint/suspicious/noBitwiseOperators: Assert POSIX permissions independently of file type bits.
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });
});

function entryKind(entry: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}): string {
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isFile()) {
    return "file";
  }
  return "other";
}
