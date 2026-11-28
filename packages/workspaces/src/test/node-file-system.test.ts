import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageChecks } from "@foundry/core/testing/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeFileSystem } from "../node";
import { makeRoot } from "./helpers/temp-roots";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    chmod: vi.fn(fs.chmod),
    readdir: vi.fn(fs.readdir),
    rename: vi.fn(fs.rename),
  };
});

afterEach(() => vi.clearAllMocks());

describe("disk storage", () => {
  for (const test of storageChecks) {
    it(test.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "storage-"));
      try {
        await mkdir(join(root, "empty"));
        await mkdir(join(root, "nested"));
        await writeFile(join(root, "kept.txt"), "original");
        await writeFile(join(root, "nested/value.txt"), "nested");
        await symlink("kept.txt", join(root, "link"));
        await test.run({
          failNextDirectoryRead() {
            vi.mocked(readdir).mockRejectedValueOnce(
              new Error("readdir failed")
            );
          },
          failNextReplacement() {
            vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));
          },
          root,
          storage: nodeFileSystem,
        });
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
  }
});

describe("nodeFileSystem.replaceFile permissions", () => {
  it("applies the existing permission bits through the open handle, not by path", async () => {
    const root = await makeRoot({ "mode.txt": "before" });
    const target = join(root, "mode.txt");
    await chmod(target, 0o640);
    vi.mocked(chmod).mockClear();

    await nodeFileSystem.replaceFile(target, new TextEncoder().encode("after"));

    expect(chmod).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("after");
    // biome-ignore lint/suspicious/noBitwiseOperators: Filesystem permissions are a bit mask.
    expect((await lstat(target)).mode & 0o7777).toBe(0o640);
    expect(await readdir(root)).toEqual(["mode.txt"]);
  });
});

describe("nodeFileSystem.replaceFile contents and failures", () => {
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
