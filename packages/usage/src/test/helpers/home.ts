import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const tempHome = (): Promise<string> =>
  mkdtemp(join(tmpdir(), "usage-test-"));

export const writeJsonl = async (
  path: string,
  lines: readonly unknown[],
  mtime?: Date
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
  if (mtime) {
    await utimes(path, mtime, mtime);
  }
};

export const touch = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
};
