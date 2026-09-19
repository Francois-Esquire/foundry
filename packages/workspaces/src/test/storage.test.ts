import type * as NodeFs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageChecks } from "@foundry/core/testing/storage";
import { afterEach, describe, it, vi } from "vitest";

import { nodeFileSystem } from "../node";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return { ...fs, readdir: vi.fn(fs.readdir), rename: vi.fn(fs.rename) };
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
