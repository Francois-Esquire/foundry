import { fstatSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { writeFileAtomicSync } from "../atomic-file";

/**
 * Kept apart from the other atomic-file tests because the module mock below
 * is hoisted over the whole file. It only observes: every call goes through.
 */
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, writeFileSync: vi.fn(original.writeFileSync) };
});

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lib-atomic-file-mode-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

function permissions(mode: number): number {
  return mode % 0o1_0000;
}

it("writes the bytes into a temporary that already has the requested mode", async () => {
  const modesWhileWriting: number[] = [];
  const write = vi.mocked(writeFileSync);
  const original = write.getMockImplementation();
  write.mockImplementation((file, data, options) => {
    original?.(file, data, options);
    const stats = typeof file === "number" ? fstatSync(file) : statSync(file);
    modesWhileWriting.push(permissions(stats.mode));
  });
  const path = join(directory, "token");
  const umask = process.umask(0o000);
  try {
    writeFileAtomicSync(path, "secret", { mode: 0o600 });
  } finally {
    process.umask(umask);
    write.mockImplementation(original ?? (() => undefined));
  }

  expect(modesWhileWriting).toEqual([0o600]);
  expect(permissions((await stat(path)).mode)).toBe(0o600);
  expect(await readdir(directory)).toEqual(["token"]);
});

it("writes a file whose requested mode is read-only", async () => {
  const path = join(directory, "sealed");
  writeFileAtomicSync(path, "sealed", { fsync: true, mode: 0o400 });

  expect(await readFile(path, "utf8")).toBe("sealed");
  expect(permissions((await stat(path)).mode)).toBe(0o400);
});
