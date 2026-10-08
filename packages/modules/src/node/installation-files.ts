import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { InstallationId } from "../domain";
import type { ModuleInstallationFiles } from "../platform/files";

import { KeyedTurns } from "../platform/turns";

export type {
  ModuleInstallationFiles,
  PreparedInstallationFiles,
} from "../platform/files";

const DATABASE_FILE = "data.sqlite";
const BACKUP_FILE = "data.sqlite.bak";
const EMPTY_BACKUP_FILE = ".data.sqlite.backup-empty";
const LEGACY_LIVE_DIRECTORY = "live";
const FILES_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const DEFAULT_INSTALLATION_FILES_QUOTA_BYTES = 512 * 1024 * 1024;

export interface CreateModuleInstallationFilesOptions {
  /** The retired Data Space root whose `live` directories are moved in. */
  readonly legacyRoot?: string;
  readonly quotaBytes?: number;
  readonly root: string;
  /**
   * Writes a transactionally consistent copy of a SQLite database, WAL
   * included, to a path that does not exist yet. The host supplies its driver.
   */
  readonly snapshotDatabase: (
    source: string,
    destination: string
  ) => Promise<void>;
}

export class ModuleInstallationFilesError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleInstallationFilesError";
  }
}

export function createModuleInstallationFiles(
  options: CreateModuleInstallationFilesOptions
): ModuleInstallationFiles {
  const root = path.resolve(options.root);
  const legacyRoot =
    options.legacyRoot === undefined
      ? undefined
      : path.resolve(options.legacyRoot);
  const quotaBytes =
    options.quotaBytes ?? DEFAULT_INSTALLATION_FILES_QUOTA_BYTES;
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) {
    throw new TypeError(
      "Installation files quota must be a positive safe integer"
    );
  }
  const turns = new KeyedTurns<InstallationId>();

  function directoryOf(installationId: InstallationId): string {
    if (!FILES_DIRECTORY_NAME.test(installationId)) {
      throw new ModuleInstallationFilesError(
        `Installation id ${JSON.stringify(installationId)} cannot name a files directory`
      );
    }
    return path.join(root, installationId);
  }

  async function ensureDirectory(
    installationId: InstallationId
  ): Promise<string> {
    await mkdir(root, { mode: 0o700, recursive: true });
    await chmod(root, 0o700);
    const directory = directoryOf(installationId);
    const existing = await lstat(directory).catch(missingOnly);
    if (
      existing !== undefined &&
      (!existing.isDirectory() || existing.isSymbolicLink())
    ) {
      throw new ModuleInstallationFilesError(
        "Installation files directory is not a real directory"
      );
    }
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    return directory;
  }

  const files: ModuleInstallationFiles = {
    backup: (installationId) =>
      turns.run(installationId, async () => {
        const directory = await ensureDirectory(installationId);
        if (legacyRoot !== undefined) {
          await moveLegacyLiveDirectory(legacyRoot, installationId, directory);
        }
        const database = path.join(directory, DATABASE_FILE);
        if (
          (await lstat(path.join(directory, BACKUP_FILE)).catch(
            missingOnly
          )) !== undefined ||
          (await lstat(path.join(directory, EMPTY_BACKUP_FILE)).catch(
            missingOnly
          )) !== undefined
        ) {
          return;
        }
        const metadata = await lstat(database).catch(missingOnly);
        if (metadata !== undefined && !metadata.isFile()) {
          throw new ModuleInstallationFilesError(
            "Installation database is not a real file"
          );
        }
        if (metadata === undefined || metadata.size === 0) {
          await writeFile(path.join(directory, EMPTY_BACKUP_FILE), "", {
            flag: "wx",
            mode: 0o600,
          });
          return;
        }
        const temporary = path.join(
          directory,
          `${BACKUP_FILE}.${randomUUID()}.tmp`
        );
        try {
          await options.snapshotDatabase(database, temporary);
          await chmod(temporary, 0o600);
          await rename(temporary, path.join(directory, BACKUP_FILE));
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        await enforceQuota(directory, quotaBytes);
      }),

    delete: (installationId) =>
      turns.run(installationId, async () => {
        const directory = directoryOf(installationId);
        const metadata = await lstat(directory).catch(missingOnly);
        if (metadata !== undefined) {
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new ModuleInstallationFilesError(
              "Installation files deletion target is not a real directory"
            );
          }
          await rm(directory, { force: false, recursive: true });
        }
        if (legacyRoot !== undefined) {
          await rm(legacyDirectory(legacyRoot, installationId), {
            force: true,
            recursive: true,
          });
        }
      }),

    discardBackup: (installationId) =>
      turns.run(installationId, async () => {
        await rm(path.join(directoryOf(installationId), BACKUP_FILE), {
          force: true,
        });
        await rm(path.join(directoryOf(installationId), EMPTY_BACKUP_FILE), {
          force: true,
        });
      }),
    prepare: ({ installationId, signal }) =>
      turns.run(installationId, async () => {
        signal?.throwIfAborted();
        const directory = await ensureDirectory(installationId);
        if (legacyRoot !== undefined) {
          await moveLegacyLiveDirectory(legacyRoot, installationId, directory);
        }
        await enforceQuota(directory, quotaBytes);
        signal?.throwIfAborted();
        return Object.freeze({ hostPath: directory, installationId });
      }),

    release: (installationId) =>
      turns.run(installationId, async () => {
        await enforceQuota(await ensureDirectory(installationId), quotaBytes);
      }),

    restoreBackup: (installationId) =>
      turns.run(installationId, async () => {
        const directory = await ensureDirectory(installationId);
        const backup = path.join(directory, BACKUP_FILE);
        const database = path.join(directory, DATABASE_FILE);
        if (
          (await lstat(path.join(directory, EMPTY_BACKUP_FILE)).catch(
            missingOnly
          )) !== undefined
        ) {
          await rm(`${database}-wal`, { force: true });
          await rm(`${database}-shm`, { force: true });
          await rm(database, { force: true });
          return true;
        }
        if ((await lstat(backup).catch(missingOnly)) === undefined) {
          return false;
        }
        const temporary = `${database}.${randomUUID()}.restore`;
        try {
          await copyFile(backup, temporary);
          await chmod(temporary, 0o600);
          // A sidecar left beside the restored file would replay the failed
          // version's frames into it on the next open.
          await rm(`${database}-wal`, { force: true });
          await rm(`${database}-shm`, { force: true });
          await rename(temporary, database);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        return true;
      }),
  };
  return Object.freeze(files);
}

function legacyDirectory(
  legacyRoot: string,
  installationId: InstallationId
): string {
  return path.join(
    legacyRoot,
    createHash("sha256").update(`installation:${installationId}`).digest("hex")
  );
}

/**
 * Moves every entry of the legacy live directory, SQLite sidecars included.
 * Each entry moves by one rename, so an interrupted run leaves every file in
 * exactly one place and a repeat finishes the rest. An occupied destination
 * is never overwritten: the move stops and the source stays.
 */
async function moveLegacyLiveDirectory(
  legacyRoot: string,
  installationId: InstallationId,
  destination: string
): Promise<void> {
  const legacy = legacyDirectory(legacyRoot, installationId);
  const live = path.join(legacy, LEGACY_LIVE_DIRECTORY);
  const entries = await readdir(live).catch(missingOnly);
  if (entries === undefined) {
    return;
  }
  for (const name of entries) {
    const target = path.join(destination, name);
    if ((await lstat(target).catch(missingOnly)) !== undefined) {
      throw new ModuleInstallationFilesError(
        `Legacy Installation file ${JSON.stringify(name)} already exists in the files directory; both copies were left untouched`
      );
    }
    await moveEntry(path.join(live, name), target);
  }
  await rmdir(live).catch(() => undefined);
  // Snapshots and staging copies may remain, so this goes only when empty.
  // The root itself is the host's: a live container registry may still
  // resolve it as a trusted mount root.
  await rmdir(legacy).catch(() => undefined);
}

function missingOnly(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

async function moveEntry(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    const temporary = `${target}.${randomUUID()}.move`;
    try {
      await cp(source, temporary, {
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        recursive: true,
        verbatimSymlinks: true,
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true, recursive: true }).catch(
        () => undefined
      );
    }
    await rm(source, { recursive: true });
  }
}

async function enforceQuota(
  directory: string,
  quotaBytes: number
): Promise<void> {
  const bytes = await directoryBytes(directory);
  if (bytes > quotaBytes) {
    throw new ModuleInstallationFilesError(
      `Installation files exceed their ${quotaBytes}-byte quota`
    );
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const metadata = await lstat(target);
    if (metadata.isDirectory()) {
      total += await directoryBytes(target);
    } else {
      total += metadata.size;
    }
  }
  return total;
}
