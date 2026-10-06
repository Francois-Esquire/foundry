import type { Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

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

/**
 * Write `data` to `temporary`, sync it, then rename it over `target`. The
 * temporary file is removed when any step fails.
 */
export async function writeAtomically(
  target: string,
  temporary: string,
  data: string | Uint8Array | AsyncIterable<Uint8Array>,
  options: { readonly readOnly?: boolean } = {}
): Promise<void> {
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      if (typeof data === "string" || data instanceof Uint8Array) {
        await file.writeFile(data);
      } else {
        for await (const part of data) {
          await file.writeFile(part);
        }
      }
      await file.sync();
      if (options.readOnly) {
        await file.chmod(0o400);
      }
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
