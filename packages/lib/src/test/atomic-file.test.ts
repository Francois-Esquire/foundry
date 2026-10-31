import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasErrorCode,
  isMissingPath,
  readJsonFile,
  syncDirectorySync,
  writeFileAtomic,
  writeFileAtomicSync,
} from "../atomic-file";

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

  it.each([false, true])(
    "sets the mode exactly, whatever the umask (fsync: %s)",
    async (fsync) => {
      const path = join(directory, "journal.json");
      const umask = process.umask(0o277);
      try {
        await writeFileAtomic(path, "{}", { fsync, mode: 0o600 });
      } finally {
        process.umask(umask);
      }
      expect((await stat(path)).mode % 0o1_0000).toBe(0o600);
      expect(await readdir(directory)).toEqual(["journal.json"]);
    }
  );

  it("leaves no temporary behind when the rename fails", async () => {
    // Renaming a file over a directory fails after the temporary is written.
    const blocked = join(directory, "blocked");
    await writeFileAtomic(join(blocked, "inner"), "x", {
      directoryMode: 0o700,
    });

    await expect(writeFileAtomic(blocked, "lost")).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["blocked"]);
    expect(await readdir(blocked)).toEqual(["inner"]);
  });
});

describe("writeFileAtomicSync", () => {
  it("flushes when asked, and still leaves no temporary behind", async () => {
    const path = join(directory, "flushed", "journal.json");
    writeFileAtomicSync(path, "{}", { createDirectory: true, fsync: true });
    expect(await readFile(path, "utf8")).toBe("{}");
    expect(await readdir(join(directory, "flushed"))).toEqual(["journal.json"]);
    expect(() => syncDirectorySync(join(directory, "flushed"))).not.toThrow();
  });

  it("sets the mode exactly, whatever the umask", async () => {
    const path = join(directory, "script.sh");
    const umask = process.umask(0o077);
    try {
      writeFileAtomicSync(path, "#!/bin/sh\n", { mode: 0o755 });
    } finally {
      process.umask(umask);
    }
    expect((await stat(path)).mode % 0o1_0000).toBe(0o755);
    expect(await readdir(directory)).toEqual(["script.sh"]);
  });

  it("replaces the file and leaves no temporary behind", async () => {
    const path = join(directory, "nested", "state.json");
    writeFileAtomicSync(path, "first", { createDirectory: true });
    writeFileAtomicSync(path, "second");

    expect(await readFile(path, "utf8")).toBe("second");
    expect(await readdir(join(directory, "nested"))).toEqual(["state.json"]);
  });

  it("leaves no temporary behind when the rename fails", async () => {
    // Renaming a file over a directory fails after the temporary is written.
    const blocked = join(directory, "blocked");
    writeFileAtomicSync(join(blocked, "inner"), "x", { createDirectory: true });

    expect(() => writeFileAtomicSync(blocked, "lost")).toThrow();
    expect(await readdir(directory)).toEqual(["blocked"]);
    expect(await readdir(blocked)).toEqual(["inner"]);
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

describe("isMissingPath", () => {
  it("matches a missing path and a file in place of a directory, and nothing else", async () => {
    const missing = await readFile(join(directory, "missing")).catch(
      (caught: unknown) => caught
    );
    const file = join(directory, "file");
    await writeFile(file, "");
    const underFile = await readFile(join(file, "child")).catch(
      (caught: unknown) => caught
    );
    const directoryRead = await readFile(directory).catch(
      (caught: unknown) => caught
    );
    expect(isMissingPath(missing)).toBe(true);
    expect(isMissingPath(underFile)).toBe(true);
    expect(isMissingPath(directoryRead)).toBe(false);
    expect(isMissingPath(new Error("ENOENT"))).toBe(false);
  });
});
