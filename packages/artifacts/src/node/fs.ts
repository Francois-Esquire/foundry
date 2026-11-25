import type { Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { hasErrorCode } from "@foundry/lib/node/atomic-file";

export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export async function writeAtomically(
  target: string,
  temporary: string,
  data: AsyncIterable<Uint8Array>
): Promise<void> {
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      for await (const part of data) {
        await file.writeFile(part);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
