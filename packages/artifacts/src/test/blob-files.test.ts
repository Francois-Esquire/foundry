import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { blobFiles } from "../node";

/**
 * Only publishing makes the blobs directory: a reader of a missing one
 * finds no blobs and makes nothing.
 */

it("lists, reads and removes nothing in a missing directory, and makes none", async () => {
  const root = join(
    mkdtempSync(join(tmpdir(), "artifacts-blob-files-")),
    "blobs"
  );
  const files = blobFiles(root);
  const listed: string[] = [];
  for await (const name of files.list()) {
    listed.push(name);
  }
  expect(listed).toEqual([]);
  const read = async () => {
    for await (const _chunk of files.read("0a1b2c3d", { end: 1, start: 0 })) {
      // Nothing to read.
    }
  };
  await expect(read()).rejects.toMatchObject({ code: "ENOENT" });
  await files.remove("0a1b2c3d");
  expect(existsSync(root)).toBe(false);
  const published = await files.publish(new TextEncoder().encode("bytes"));
  expect(existsSync(join(root, published))).toBe(true);
});
