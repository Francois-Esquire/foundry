import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasErrorCode, readJsonFile, writeFileAtomic } from "../atomic-file";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lib-atomic-file-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("writeFileAtomic", () => {
  it.each([false, true])(
    "replaces the file and leaves no temporary behind (fsync: %s)",
    async (fsync) => {
      const path = join(directory, "nested", "state.json");
      await writeFileAtomic(path, "first", {
        directoryMode: 0o700,
        fsync,
        mode: 0o600,
      });
      await writeFileAtomic(path, "second", { fsync, mode: 0o600 });

      expect(await readFile(path, "utf8")).toBe("second");
      expect(await readdir(join(directory, "nested"))).toEqual(["state.json"]);
      // biome-ignore lint/suspicious/noBitwiseOperators: Mask file type bits to check private POSIX permissions.
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  );

  it("leaves the previous file and nothing else when the write fails", async () => {
    const path = join(directory, "state.json");
    await writeFileAtomic(path, "kept");
    // Renaming a file over a directory fails after the temporary is written.
    const blocked = join(directory, "blocked");
    await writeFileAtomic(join(blocked, "inner"), "x", {
      directoryMode: 0o700,
    });

    await expect(writeFileAtomic(blocked, "lost")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("kept");
    expect((await readdir(directory)).sort()).toEqual([
      "blocked",
      "state.json",
    ]);
  });
});

describe("readJsonFile", () => {
  it("reads absence as undefined", async () => {
    await expect(
      readJsonFile(join(directory, "missing.json"))
    ).resolves.toBeUndefined();
  });

  it("parses a file and throws on damage instead of reading it as absent", async () => {
    const path = join(directory, "state.json");
    await writeFileAtomic(path, '{"a":1}');
    await expect(readJsonFile(path)).resolves.toEqual({ a: 1 });
    await writeFileAtomic(path, "{damaged");
    await expect(readJsonFile(path)).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("hasErrorCode", () => {
  it("matches a system error by code and nothing else", async () => {
    const error = await readFile(join(directory, "missing")).catch(
      (caught: unknown) => caught
    );
    expect(hasErrorCode(error, "ENOENT")).toBe(true);
    expect(hasErrorCode(error, "EEXIST")).toBe(false);
    expect(hasErrorCode(new Error("ENOENT"), "ENOENT")).toBe(false);
    expect(hasErrorCode({ code: "ENOENT" }, "ENOENT")).toBe(false);
  });
});
