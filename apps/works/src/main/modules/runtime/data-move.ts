import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import {
  hasErrorCode,
  readJsonFile,
  writeFileAtomic,
} from "@foundry/lib/atomic-file";
import { z } from "zod";
import { ModuleRuntimeError } from "./controller";

const DATABASE = "data.sqlite";
/** Databases checked after copying; the live one is a fresh snapshot. */
const DATABASES = [DATABASE, `${DATABASE}.bak`] as const;
/** Folded into the snapshot; copied beside it they would replay stale frames. */
const SIDECARS = new Set([`${DATABASE}-wal`, `${DATABASE}-shm`]);
const STAGING = ".data-moving";

const stateSchema = z.object({
  format: z.literal("works.data-move/1"),
  status: z.enum(["copying", "adopting", "done"]),
});
type MoveStatus = z.infer<typeof stateSchema>["status"];

export interface LegacyDataMove {
  /** Opens a database where it lies and checks its integrity. */
  readonly checkDatabase: (file: string) => Promise<void>;
  /** The earlier location, `.data/<moduleDirectory>/`. */
  readonly from: string;
  /** A consistent copy of a database, WAL included, to a new path. */
  readonly snapshotDatabase: (
    source: string,
    destination: string
  ) => Promise<void>;
  /** Where the move records how far it got, so a restart resumes it. */
  readonly state: string;
  /** The Module's `data/`. */
  readonly to: string;
}

class DataMoveError extends ModuleRuntimeError {}

/**
 * Moves a Module's private files from the earlier location into its
 * `data/` once. The caller guarantees its Program is stopped and nothing
 * holds the database open. A consistent copy is staged beside `data/`,
 * checked (databases opened and integrity-checked, other files compared
 * byte for byte), placed by one rename and opened again there. The
 * original stays until all of that succeeded; any failure leaves it in
 * use and the next attempt starts over. `data/` that already holds files
 * is never overwritten.
 */
export async function moveLegacyData(move: LegacyDataMove): Promise<void> {
  const status = await readStatus(move.state);
  if (status === "done") {
    return;
  }
  const staging = path.join(path.dirname(move.to), STAGING);
  if (status === "adopting") {
    // The checked copy was complete before the restart; finish placing it.
    if (await exists(staging)) {
      await adopt(staging, move.to);
    }
    if (await exists(move.to)) {
      await finish(move, staging);
      return;
    }
    // Nothing was placed after all: start over from the original.
    await rm(move.state, { force: true });
  }
  const entries = await readdir(move.from).catch(missing);
  if (entries === undefined || entries.length === 0) {
    return;
  }
  if (await occupied(move.to)) {
    throw new DataMoveError(
      "This Module has private data in both its data folder and the earlier location. Both were left untouched."
    );
  }
  await rm(staging, { force: true, recursive: true });
  await writeStatus(move.state, "copying");
  await mkdir(path.dirname(staging), { mode: 0o700, recursive: true });
  await mkdir(staging, { mode: 0o700 });
  try {
    await copy(move, entries, staging);
    await check(move, entries, staging);
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw new DataMoveError(
      "This Module's private data could not be moved. The original was left in place.",
      { cause: error }
    );
  }
  await writeStatus(move.state, "adopting");
  await adopt(staging, move.to);
  await finish(move, staging);
}

async function copy(
  move: LegacyDataMove,
  entries: readonly string[],
  staging: string
) {
  for (const name of entries) {
    if (SIDECARS.has(name)) {
      continue;
    }
    const source = path.join(move.from, name);
    const target = path.join(staging, name);
    if (name === DATABASE && (await lstat(source)).size > 0) {
      await move.snapshotDatabase(source, target);
      await chmod(target, 0o600);
      continue;
    }
    await copyTree(source, target);
  }
}

/** Real files, directories and links, never following a link. */
async function copyTree(source: string, target: string) {
  const entry = await lstat(source);
  if (entry.isDirectory()) {
    await mkdir(target, { mode: entry.mode });
    for (const name of await readdir(source)) {
      await copyTree(path.join(source, name), path.join(target, name));
    }
  } else if (entry.isFile()) {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } else if (entry.isSymbolicLink()) {
    await symlink(await readlink(source), target);
  } else {
    throw new Error(`${source} is not a file, directory or link`);
  }
}

async function check(
  move: LegacyDataMove,
  entries: readonly string[],
  staging: string
) {
  for (const name of entries) {
    if (SIDECARS.has(name) || name === DATABASE) {
      continue;
    }
    if (!(await same(path.join(move.from, name), path.join(staging, name)))) {
      throw new Error(`The copy of ${name} differs from the original`);
    }
  }
  await checkDatabases(move, staging);
}

async function checkDatabases(move: LegacyDataMove, directory: string) {
  for (const name of DATABASES) {
    const file = path.join(directory, name);
    if ((await lstat(file).catch(missing))?.isFile()) {
      await move.checkDatabase(file);
    }
  }
}

/** Opened again where it now lies; only then is the original let go. */
async function finish(move: LegacyDataMove, staging: string) {
  try {
    await checkDatabases(move, move.to);
  } catch (error) {
    // Undo the placement, so the original stays the one in use.
    await rename(move.to, staging);
    await rm(staging, { force: true, recursive: true });
    await rm(move.state, { force: true });
    throw new DataMoveError(
      "This Module's moved private data did not open. The original was left in place.",
      { cause: error }
    );
  }
  await writeStatus(move.state, "done");
  await rm(move.from, { force: true, recursive: true });
}

async function adopt(staging: string, destination: string) {
  if (await occupied(destination)) {
    throw new DataMoveError(
      "This Module's data folder already holds files. The earlier private data was left untouched."
    );
  }
  await rmdir(destination).catch(missing);
  await rename(staging, destination);
}

/** Same kind of entry with the same bytes, recursively. */
async function same(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([lstat(left), lstat(right)]);
  if (a.isDirectory() !== b.isDirectory() || a.isFile() !== b.isFile()) {
    return false;
  }
  if (a.isFile()) {
    return (await digest(left)) === (await digest(right));
  }
  if (!a.isDirectory()) {
    return true;
  }
  const names = (await readdir(left)).sort();
  const others = (await readdir(right)).sort();
  if (names.join("\0") !== others.join("\0")) {
    return false;
  }
  for (const name of names) {
    if (!(await same(path.join(left, name), path.join(right, name)))) {
      return false;
    }
  }
  return true;
}

async function digest(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function occupied(directory: string) {
  const names = await readdir(directory).catch(missing);
  return names !== undefined && names.length > 0;
}

async function exists(target: string) {
  return (await lstat(target).catch(missing)) !== undefined;
}

async function readStatus(file: string): Promise<MoveStatus | null> {
  const value = await readJsonFile(file);
  return value === undefined ? null : stateSchema.parse(value).status;
}

function writeStatus(file: string, status: MoveStatus): Promise<void> {
  return writeFileAtomic(
    file,
    JSON.stringify({ format: "works.data-move/1", status }),
    { directoryMode: 0o700, mode: 0o600 }
  );
}

function missing(error: unknown): undefined {
  if (!hasErrorCode(error, "ENOENT")) {
    throw error;
  }
}
