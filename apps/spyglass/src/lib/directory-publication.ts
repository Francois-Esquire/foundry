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

function generations(directory: string): string {
  return join(dirname(directory), `.${basename(directory)}.generations`);
}

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

export function discardDirectory(directory: string): void {
  rmSync(directory, { force: true, recursive: true });
  rmSync(generations(directory), { force: true, recursive: true });
}

function removeObsoleteGeneration(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    // Never report a published dataset as a failed write because of cleanup.
  }
}
