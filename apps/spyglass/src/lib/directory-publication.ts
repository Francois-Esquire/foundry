import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Immutable generations live beside the public path, outside the dataset. */
function generations(directory: string): string {
  return join(dirname(directory), `.${basename(directory)}.generations`);
}

/**
 * Recovers the directory format used before generation pointers. Migration
 * needs one rename of that legacy directory; its backup must survive a
 * process exit before the pointer is installed. Normal publications only
 * replace a symlink and never remove the public path.
 */
export function recoverDirectory(directory: string): void {
  if (existsSync(directory) || !existsSync(dirname(directory))) {
    return;
  }
  const prefix = `${basename(directory)}.old-`;
  const backup = readdirSync(dirname(directory)).find((name) =>
    name.startsWith(prefix)
  );
  if (backup !== undefined) {
    renameSync(join(dirname(directory), backup), directory);
  }
}

/** Publishes a complete generation by atomically replacing its public symlink. */
export function replaceDirectory(stage: string, directory: string): void {
  recoverDirectory(directory);
  const store = generations(directory);
  mkdirSync(store, { recursive: true });
  const generation = join(store, randomUUID());
  const pointer = `${directory}.pointer-${randomUUID()}`;
  const legacy = `${directory}.old-${process.pid}`;
  let previous: string | undefined;
  let migrated = false;
  const stageIsLink = lstatSync(stage).isSymbolicLink();
  renameSync(stageIsLink ? realpathSync(stage) : stage, generation);
  if (stageIsLink) {
    rmSync(stage);
  }
  try {
    symlinkSync(relative(dirname(directory), generation), pointer, "dir");
    if (existsSync(directory)) {
      if (lstatSync(directory).isSymbolicLink()) {
        previous = resolve(dirname(directory), readlinkSync(directory));
      } else {
        renameSync(directory, legacy);
        migrated = true;
      }
    }
    renameSync(pointer, directory);
  } catch (error) {
    if (migrated) {
      renameSync(legacy, directory);
    }
    rmSync(pointer, { force: true });
    rmSync(generation, { force: true, recursive: true });
    throw error;
  }
  // A reader that already resolved the old pointer can finish against it.
  // Retain the previous generation as well as the newly published one.
  for (const name of readdirSync(store)) {
    const path = join(store, name);
    if (path !== generation && path !== previous) {
      removeObsoleteGeneration(path);
    }
  }
  if (migrated) {
    removeObsoleteGeneration(legacy);
  }
}

/** Discards a private publication, including generations its symlink owns. */
export function discardDirectory(directory: string): void {
  rmSync(directory, { force: true, recursive: true });
  rmSync(generations(directory), { force: true, recursive: true });
}

/** Publication already succeeded; cleanup failure leaves an unreferenced generation for the next scan. */
function removeObsoleteGeneration(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    // Never report a published dataset as a failed write because of cleanup.
  }
}
