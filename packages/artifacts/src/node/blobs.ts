import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hasErrorCode, writeFileAtomic } from "@foundry/lib/atomic-file";

import type { BlobFiles } from "../blob";

/**
 * A published blob, or a temporary left beside one: `<id>.<uuid>.tmp` from
 * `writeFileAtomic`, or `<id>.tmp` from earlier releases.
 */
const BLOB_FILENAME = /^[a-f0-9-]+(?:\.(?:[a-f0-9-]+\.)?tmp)?$/;

export function blobFiles(root: string): BlobFiles {
  const directory = resolve(root);
  async function ready(): Promise<string> {
    await mkdir(directory, { recursive: true });
    return realpath(directory);
  }
  function filename(path: string): string {
    if (!BLOB_FILENAME.test(path)) {
      throw new Error("Invalid blob storage path");
    }
    return path;
  }
  return {
    async *list() {
      for (const entry of await readdir(await ready(), {
        withFileTypes: true,
      })) {
        if (BLOB_FILENAME.test(entry.name)) {
          yield entry.name;
        }
      }
    },
    async publish(bytes) {
      const base = await ready();
      const path = crypto.randomUUID();
      await writeFileAtomic(join(base, path), bytes, {
        fsync: true,
        mode: 0o400,
      });
      return path;
    },
    async *read(path, { start, end }) {
      const file = await open(
        join(await ready(), filename(path)),
        // biome-ignore lint/suspicious/noBitwiseOperators: Node open flags require a bitmask to reject symlinks.
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      try {
        const stats = await file.stat();
        if (!stats.isFile()) {
          throw new Error("Blob source is not a regular file");
        }
        let offset = start;
        while (offset < end) {
          const buffer = new Uint8Array(Math.min(64 * 1024, end - offset));
          const { bytesRead } = await file.read(
            buffer,
            0,
            buffer.length,
            offset
          );
          if (bytesRead === 0) {
            throw new Error("Blob source ended early");
          }
          offset += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      } finally {
        await file.close();
      }
    },
    async remove(path) {
      try {
        await unlink(join(await ready(), filename(path)));
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    },
  };
}
