import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  constants,
  cp,
  lstat,
  mkdir,
  open,
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
const DATABASE_SIDECARS = ["-wal", "-shm"] as const;
const BACKUP_FILE = "data.sqlite.bak";
const EMPTY_BACKUP_FILE = ".data.sqlite.backup-empty";
/**
 * Backups sit under the root but outside every files directory: the Program
 * may write anything in its own mounted directory, so the host keeps its
 * rollback copy where no mount reaches. The leading dot keeps the name out of
 * the Installation directory namespace.
 */
const BACKUPS_DIRECTORY = ".backups";
const COPY_CHUNK_BYTES = 1024 * 1024;
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
  const backupsRoot = path.join(root, BACKUPS_DIRECTORY);
  const turns = new KeyedTurns<InstallationId>();

  function directoryName(installationId: InstallationId): string {
    if (!FILES_DIRECTORY_NAME.test(installationId)) {
      throw new ModuleInstallationFilesError(
        `Installation id ${JSON.stringify(installationId)} cannot name a files directory`
      );
    }
    return installationId;
  }

  function directoryOf(installationId: InstallationId): string {
    return path.join(root, directoryName(installationId));
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

  function backupDirectoryOf(installationId: InstallationId): string {
    return path.join(backupsRoot, directoryName(installationId));
  }

  async function ensureBackupDirectory(
    installationId: InstallationId
  ): Promise<string> {
    const directory = backupDirectoryOf(installationId);
    await mkdir(directory, { mode: 0o700, recursive: true });
    await assertRealDirectory(backupsRoot);
    await assertRealDirectory(directory);
    await chmod(backupsRoot, 0o700);
    await chmod(directory, 0o700);
    return directory;
  }

  /** The backup directory when one was ever made; never created here. */
  async function existingBackupDirectory(
    installationId: InstallationId
  ): Promise<string | undefined> {
    const directory = backupDirectoryOf(installationId);
    if ((await lstat(backupsRoot).catch(missingOnly)) === undefined) {
      return;
    }
    await assertRealDirectory(backupsRoot);
    if ((await lstat(directory).catch(missingOnly)) === undefined) {
      return;
    }
    await assertRealDirectory(directory);
    return directory;
  }

  const files: ModuleInstallationFiles = {
    backup: (installationId) =>
      turns.run(installationId, async () => {
        const directory = await ensureDirectory(installationId);
        if (legacyRoot !== undefined) {
          await moveLegacyLiveDirectory(legacyRoot, installationId, directory);
        }
        const backups = await ensureBackupDirectory(installationId);
        if (await holdsBackup(backups)) {
          return;
        }
        const database = path.join(directory, DATABASE_FILE);
        if (!(await hasSnapshotContent(database))) {
          await writeFile(path.join(backups, EMPTY_BACKUP_FILE), "", {
            flag: "wx",
            mode: 0o600,
          });
          return;
        }
        const temporary = path.join(
          backups,
          `${BACKUP_FILE}.${randomUUID()}.tmp`
        );
        try {
          await options.snapshotDatabase(database, temporary);
          await chmod(temporary, 0o600);
          await rename(temporary, path.join(backups, BACKUP_FILE));
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        await enforceQuota([directory, backups], quotaBytes);
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
        const backups = await existingBackupDirectory(installationId);
        if (backups !== undefined) {
          await rm(backups, { force: false, recursive: true });
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
        const backups = await existingBackupDirectory(installationId);
        if (backups === undefined) {
          return;
        }
        await rm(path.join(backups, BACKUP_FILE), { force: true });
        await rm(path.join(backups, EMPTY_BACKUP_FILE), { force: true });
      }),
    prepare: ({ installationId, signal }) =>
      turns.run(installationId, async () => {
        signal?.throwIfAborted();
        const directory = await ensureDirectory(installationId);
        if (legacyRoot !== undefined) {
          await moveLegacyLiveDirectory(legacyRoot, installationId, directory);
        }
        await enforceQuota(
          [directory, await existingBackupDirectory(installationId)],
          quotaBytes
        );
        signal?.throwIfAborted();
        return Object.freeze({ hostPath: directory, installationId });
      }),

    release: (installationId) =>
      turns.run(installationId, async () => {
        await enforceQuota(
          [
            await ensureDirectory(installationId),
            await existingBackupDirectory(installationId),
          ],
          quotaBytes
        );
      }),

    restoreBackup: (installationId) =>
      turns.run(installationId, async () => {
        const directory = await ensureDirectory(installationId);
        const backups = await existingBackupDirectory(installationId);
        if (backups === undefined) {
          return false;
        }
        const database = path.join(directory, DATABASE_FILE);
        if (
          (await lstat(path.join(backups, EMPTY_BACKUP_FILE)).catch(
            missingOnly
          )) !== undefined
        ) {
          await removeDatabase(database);
          return true;
        }
        const backup = await openHostFile(path.join(backups, BACKUP_FILE));
        if (backup === undefined) {
          return false;
        }
        const temporary = `${database}.${randomUUID()}.restore`;
        try {
          try {
            await copyInto(backup, temporary);
          } finally {
            await backup.close();
          }
          // A sidecar left beside the restored file would replay the failed
          // version's frames into it on the next open.
          await removeDatabaseSidecars(database);
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

async function holdsBackup(backups: string): Promise<boolean> {
  for (const name of [BACKUP_FILE, EMPTY_BACKUP_FILE]) {
    if (
      (await lstat(path.join(backups, name)).catch(missingOnly)) !== undefined
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the database holds anything to snapshot. The host driver opens the
 * database and its sidecars by name, so each must be a regular file.
 */
async function hasSnapshotContent(database: string): Promise<boolean> {
  const metadata = await lstat(database).catch(missingOnly);
  if (metadata !== undefined && !metadata.isFile()) {
    throw new ModuleInstallationFilesError(
      "Installation database is not a real file"
    );
  }
  if (metadata === undefined || metadata.size === 0) {
    return false;
  }
  for (const suffix of DATABASE_SIDECARS) {
    const sidecar = await lstat(`${database}${suffix}`).catch(missingOnly);
    if (sidecar !== undefined && !sidecar.isFile()) {
      throw new ModuleInstallationFilesError(
        "Installation database sidecar is not a real file"
      );
    }
  }
  return true;
}

async function assertRealDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ModuleInstallationFilesError(
      "Installation backup directory is not a real directory"
    );
  }
}

/**
 * Opens the regular file the host wrote, refusing a link or any other kind of
 * entry in its place; undefined when absent. Non-blocking, so a pipe never
 * stalls the open.
 */
async function openHostFile(file: string): Promise<FileHandle | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      file,
      // biome-ignore lint/suspicious/noBitwiseOperators: Node open flags require a bitmask to reject symlinks.
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") {
      return;
    }
    if (code === "ELOOP") {
      throw new ModuleInstallationFilesError(
        "Installation backup is not a real file",
        { cause: error }
      );
    }
    throw error;
  }
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new ModuleInstallationFilesError(
      "Installation backup is not a real file"
    );
  }
  return handle;
}

/** Copies an open file into a new private file that must not exist yet. */
async function copyInto(source: FileHandle, target: string): Promise<void> {
  const destination = await open(target, "wx", 0o600);
  try {
    const buffer = new Uint8Array(COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.length,
        position
      );
      if (bytesRead === 0) {
        break;
      }
      await destination.write(buffer, 0, bytesRead);
      position += bytesRead;
    }
  } finally {
    await destination.close();
  }
}

async function removeDatabaseSidecars(database: string): Promise<void> {
  for (const suffix of DATABASE_SIDECARS) {
    await rm(`${database}${suffix}`, { force: true });
  }
}

async function removeDatabase(database: string): Promise<void> {
  await removeDatabaseSidecars(database);
  await rm(database, { force: true });
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

/** A held backup counts against the quota it was taken under. */
async function enforceQuota(
  directories: readonly (string | undefined)[],
  quotaBytes: number
): Promise<void> {
  let bytes = 0;
  for (const directory of directories) {
    if (directory !== undefined) {
      bytes += await directoryBytes(directory);
    }
  }
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
