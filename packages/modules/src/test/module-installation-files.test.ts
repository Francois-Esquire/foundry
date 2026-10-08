import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { installationIdSchema } from "../domain";
import {
  createModuleInstallationFiles,
  ModuleInstallationFilesError,
} from "../node/installation-files";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

const installationId = installationIdSchema.parse("installation-1");

async function fixture(options: { readonly quotaBytes?: number } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "foundry-module-files-"));
  directories.push(base);
  const root = path.join(base, "files");
  const legacyRoot = path.join(base, "modules", "data");
  const snapshotDatabase = vi.fn((source: string, destination: string) =>
    copyFile(source, destination)
  );
  const files = createModuleInstallationFiles({
    legacyRoot,
    root,
    snapshotDatabase,
    ...(options.quotaBytes === undefined
      ? {}
      : { quotaBytes: options.quotaBytes }),
  });
  const legacy = path.join(
    legacyRoot,
    createHash("sha256").update(`installation:${installationId}`).digest("hex")
  );
  return {
    directory: path.join(root, installationId),
    files,
    legacy,
    legacyRoot,
    live: path.join(legacy, "live"),
    root,
    snapshotDatabase,
  };
}

async function seedLegacy(live: string): Promise<Record<string, string>> {
  const entries = {
    "data.sqlite": "main",
    "data.sqlite-shm": "shared memory",
    "data.sqlite-wal": "wal frames",
    "notes.txt": "arbitrary",
  };
  await mkdir(live, { recursive: true });
  for (const [name, text] of Object.entries(entries)) {
    await writeFile(path.join(live, name), text);
  }
  return entries;
}

async function contents(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) {
    result[name] = await readFile(path.join(directory, name), "utf8");
  }
  return result;
}

describe("Module Installation files", () => {
  it("prepares one private directory per Installation", async () => {
    const { files, root, directory } = await fixture();
    const prepared = await files.prepare({ installationId });
    expect(prepared).toEqual({ hostPath: directory, installationId });
    // biome-ignore lint/suspicious/noBitwiseOperators: masks file permission bits
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    // biome-ignore lint/suspicious/noBitwiseOperators: masks file permission bits
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual([]);
    await expect(files.prepare({ installationId })).resolves.toEqual(prepared);
  });

  it("refuses an aborted prepare and an id that cannot name a directory", async () => {
    const { files } = await fixture();
    await expect(
      files.prepare({ installationId, signal: AbortSignal.abort() })
    ).rejects.toThrow();
    for (const unsafe of ["../escape", "a/b", ".", "..", ".hidden"]) {
      await expect(
        files.prepare({ installationId: installationIdSchema.parse(unsafe) })
      ).rejects.toBeInstanceOf(ModuleInstallationFilesError);
    }
  });

  it("moves a legacy live directory in, sidecars and arbitrary files included, and is repeatable", async () => {
    const { files, live, legacy, legacyRoot, directory } = await fixture();
    const entries = await seedLegacy(live);
    await mkdir(path.join(legacy, "snapshots"));
    await writeFile(path.join(legacy, "snapshots", "old.sqlite"), "snapshot");

    await files.prepare({ installationId });
    expect(await contents(directory)).toEqual(entries);
    await expect(stat(live)).rejects.toMatchObject({ code: "ENOENT" });
    // Host-side snapshots are not the Program's; the legacy root stays.
    expect(await readdir(legacy)).toEqual(["snapshots"]);

    await files.prepare({ installationId });
    expect(await contents(directory)).toEqual(entries);
    expect((await stat(legacyRoot)).isDirectory()).toBe(true);
  });

  it("removes an emptied legacy Installation directory but never the legacy root", async () => {
    const { files, live, legacy, legacyRoot } = await fixture();
    await seedLegacy(live);
    await files.prepare({ installationId });
    await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(legacyRoot)).isDirectory()).toBe(true);
  });

  it("finishes an interrupted move without touching what already arrived", async () => {
    const { files, live, directory } = await fixture();
    const entries = await seedLegacy(live);
    await mkdir(directory, { recursive: true });
    // The earlier run got this far: one entry renamed, the rest still legacy.
    await rm(path.join(live, "data.sqlite"));
    await writeFile(path.join(directory, "data.sqlite"), "main");

    await files.prepare({ installationId });
    expect(await contents(directory)).toEqual(entries);
  });

  it("never overwrites an occupied destination and keeps the legacy source", async () => {
    const { files, live, directory } = await fixture();
    await seedLegacy(live);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "data.sqlite"), "newer");

    await expect(files.prepare({ installationId })).rejects.toThrow(
      "both copies were left untouched"
    );
    expect(await readFile(path.join(directory, "data.sqlite"), "utf8")).toBe(
      "newer"
    );
    expect(await readFile(path.join(live, "data.sqlite"), "utf8")).toBe("main");
    await expect(files.backup(installationId)).rejects.toBeInstanceOf(
      ModuleInstallationFilesError
    );
  });

  it("backs up through the host snapshot, restores without stale sidecars, and discards", async () => {
    const { files, directory, snapshotDatabase } = await fixture();
    await files.prepare({ installationId });
    const database = path.join(directory, "data.sqlite");

    await files.backup(installationId);
    expect(snapshotDatabase).not.toHaveBeenCalled();
    await writeFile(database, "");
    await files.backup(installationId);
    expect(snapshotDatabase).not.toHaveBeenCalled();
    await writeFile(database, "failed first migration");
    await writeFile(`${database}-wal`, "failed frames");
    await writeFile(`${database}-shm`, "failed index");
    expect(await files.restoreBackup(installationId)).toBe(true);
    expect(await readdir(directory)).toEqual([".data.sqlite.backup-empty"]);
    await files.discardBackup(installationId);

    await writeFile(database, "before");
    await files.backup(installationId);
    expect(snapshotDatabase).toHaveBeenCalledOnce();
    expect(snapshotDatabase.mock.calls[0]?.[0]).toBe(database);
    expect(await readdir(directory)).toEqual([
      "data.sqlite",
      "data.sqlite.bak",
    ]);
    // biome-ignore lint/suspicious/noBitwiseOperators: masks file permission bits
    expect((await stat(`${database}.bak`)).mode & 0o777).toBe(0o600);

    await writeFile(database, "half migrated");
    await writeFile(`${database}-wal`, "failed version frames");
    await writeFile(`${database}-shm`, "failed version index");
    await writeFile(path.join(directory, "upload.bin"), "kept");
    expect(await files.restoreBackup(installationId)).toBe(true);
    expect(await contents(directory)).toEqual({
      "data.sqlite": "before",
      "data.sqlite.bak": "before",
      "upload.bin": "kept",
    });
    // The copy survives a restore, so a second failed start restores again.
    await writeFile(database, "half migrated again");
    expect(await files.restoreBackup(installationId)).toBe(true);
    expect(await readFile(database, "utf8")).toBe("before");

    await files.discardBackup(installationId);
    await files.discardBackup(installationId);
    expect(await files.restoreBackup(installationId)).toBe(false);
    expect(await readFile(database, "utf8")).toBe("before");
  });

  it("leaves no partial backup when the snapshot fails", async () => {
    const { files, directory, snapshotDatabase } = await fixture();
    await files.prepare({ installationId });
    await writeFile(path.join(directory, "data.sqlite"), "before");
    await files.backup(installationId);
    await writeFile(path.join(directory, "data.sqlite"), "later");
    await files.backup(installationId);
    expect(
      await readFile(path.join(directory, "data.sqlite.bak"), "utf8")
    ).toBe("before");
    await files.discardBackup(installationId);
    snapshotDatabase.mockImplementationOnce(async (_source, destination) => {
      await writeFile(destination, "torn");
      throw new Error("injected snapshot failure");
    });

    await expect(files.backup(installationId)).rejects.toThrow(
      "injected snapshot failure"
    );
    expect(await contents(directory)).toEqual({
      "data.sqlite": "later",
    });
  });

  it("enforces the quota on prepare, backup, and release", async () => {
    const { files, directory } = await fixture({ quotaBytes: 16 });
    await files.prepare({ installationId });
    await writeFile(path.join(directory, "data.sqlite"), "123456789");
    await files.release(installationId);
    await expect(files.backup(installationId)).rejects.toThrow("quota");
    await files.discardBackup(installationId);
    await writeFile(path.join(directory, "big.bin"), "x".repeat(32));
    await expect(files.release(installationId)).rejects.toThrow("quota");
    await expect(files.prepare({ installationId })).rejects.toThrow("quota");
  });

  it("deletes the files and any legacy remainder, and tolerates absence", async () => {
    const { files, live, legacy, directory } = await fixture();
    await seedLegacy(live);
    await files.prepare({ installationId });
    await mkdir(path.join(legacy, "snapshots"), { recursive: true });
    await writeFile(path.join(legacy, "snapshots", "old.sqlite"), "snapshot");

    await files.delete(installationId);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    await files.delete(installationId);
  });

  it("serializes operations of one Installation", async () => {
    const { files, directory, snapshotDatabase } = await fixture();
    await files.prepare({ installationId });
    await writeFile(path.join(directory, "data.sqlite"), "before");
    let release: (() => void) | undefined;
    snapshotDatabase.mockImplementationOnce(async (source, destination) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await copyFile(source, destination);
    });
    const backup = files.backup(installationId);
    const restored = files.restoreBackup(installationId);
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.();
    await backup;
    await expect(restored).resolves.toBe(true);
  });
});
