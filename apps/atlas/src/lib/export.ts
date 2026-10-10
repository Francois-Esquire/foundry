import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isMissingPath } from "@foundry/lib/atomic-file";
import { isFilesystemPathWithin } from "@foundry/lib/paths";
import { datasetReader } from "./dataset";
import { fileTransport, savedDataset } from "./dataset-files";
import type { SemanticsManifest } from "./semantics-types";
import { viewerRoot } from "./serve";
import type { WorkspaceState } from "./state";
import { lockState } from "./state";

/** Where a static viewer finds its dataset: `./data/`, as `web/dataset.ts` reads it. */
const DATA_DIRECTORY = "data";
/**
 * Written into every static viewer, listing the top-level entries Atlas
 * wrote there, so a later `exportViewer` replaces only what Atlas wrote.
 */
const MARKER = ".atlas-static-viewer.json";
/** Written by macOS's Finder into any directory it shows; never the user's work. */
const FINDER_FILE = ".DS_Store";

export interface ExportOptions {
  /** The state root (`--state`), as `ScanOptions.state`. Default `~/.foundry/atlas`. */
  state?: string;
}

/** What `exportViewer` wrote: a static viewer and the dataset it copied. */
export interface StaticViewer {
  /** The directory the static viewer is in, resolved. */
  directory: string;
  /** The manifest of the dataset it holds, read from the copy. */
  manifest: SemanticsManifest;
}

/** The marker's contents. */
interface StaticViewerMarker {
  entries: string[];
}

/**
 * Writes a static viewer to `directory`: the viewer's files at its root and
 * the workspace's saved dataset, whole, under `data/`, for any static file
 * host. Reads the saved dataset and scans nothing. The directory must be
 * absent, empty, or a previous static viewer holding nothing Atlas did not
 * write, which is replaced once the new one is complete; it must not be a
 * symbolic link, hold the workspace, or overlap the state directory or the
 * viewer's files. Holds the state directory's lock while it copies, so no
 * scan saves over the dataset meanwhile, and fails at once while one does.
 */
export async function exportViewer(
  root: string,
  directory: string,
  options: ExportOptions = {}
): Promise<StaticViewer> {
  const viewer = await viewerRoot();
  const { workspace } = await savedDataset(root, options.state);
  const target = resolve(directory);
  await checkPlace(target, workspace, viewer);
  await checkContents(target);
  const release = lockState(workspace);
  try {
    const manifest = await replaceDirectory(target, async (stage) => {
      await cp(viewer, stage, { recursive: true });
      await cp(workspace.output, join(stage, DATA_DIRECTORY), {
        recursive: true,
      });
      const marker: StaticViewerMarker = {
        entries: (await readdir(stage)).sort(),
      };
      await writeFile(join(stage, MARKER), `${JSON.stringify(marker)}\n`);
      return datasetReader(
        fileTransport(join(stage, DATA_DIRECTORY))
      ).manifest();
    });
    return { directory: target, manifest };
  } finally {
    release();
  }
}

/** Refuses a target that holds the workspace or overlaps the state directory or the viewer. */
async function checkPlace(
  target: string,
  workspace: WorkspaceState,
  viewer: string
): Promise<void> {
  const real = await resolveThroughLinks(target);
  const refuse = (reason: string): never => {
    throw new Error(`${target} ${reason}. Choose another directory.`);
  };
  if (isFilesystemPathWithin(real, workspace.root, sep)) {
    refuse(`holds the workspace ${workspace.root}`);
  }
  if (overlaps(real, await realpath(workspace.directory))) {
    refuse(`overlaps the state directory ${workspace.directory}`);
  }
  if (overlaps(real, await realpath(viewer))) {
    refuse(`overlaps the viewer's files in ${viewer}`);
  }
}

/** `path` through every symlink of its nearest existing ancestor. */
async function resolveThroughLinks(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissingPath(error) || dirname(path) === path) {
      throw error;
    }
    return join(await resolveThroughLinks(dirname(path)), basename(path));
  }
}

function overlaps(a: string, b: string): boolean {
  return isFilesystemPathWithin(a, b, sep) || isFilesystemPathWithin(b, a, sep);
}

/**
 * Refuses a target Atlas cannot replace without losing someone's files: a
 * link, a file, or a directory holding anything but an empty directory's
 * Finder file or a previous static viewer's own entries.
 */
async function checkContents(target: string): Promise<void> {
  const found = await statIfPresent(target);
  if (found === undefined) {
    return;
  }
  if (found.isSymbolicLink()) {
    throw new Error(
      `${target} is a symbolic link; Atlas does not write through links. Choose another directory.`
    );
  }
  if (!found.isDirectory()) {
    throw new Error(`${target} is not a directory. Choose another directory.`);
  }
  const written = new Set([
    ...((await readMarker(target))?.entries ?? []),
    MARKER,
    FINDER_FILE,
  ]);
  const extra = (await readdir(target))
    .sort()
    .find((entry) => !written.has(entry));
  if (extra !== undefined) {
    throw new Error(
      `${target} holds files Atlas did not write, such as ${extra}. Choose another directory.`
    );
  }
}

async function readMarker(
  directory: string
): Promise<StaticViewerMarker | undefined> {
  const path = join(directory, MARKER);
  if (!(await statIfPresent(path))?.isFile()) {
    return;
  }
  const text = await readFile(path, "utf8");
  let marker: unknown;
  try {
    marker = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      // A marker that is not JSON vouches for nothing.
      return;
    }
    throw error;
  }
  return isMarker(marker) ? marker : undefined;
}

function isMarker(value: unknown): value is StaticViewerMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => typeof entry === "string")
  );
}

/** The path's own status, not its link target's; `undefined` when nothing is there. */
async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Writes a new directory beside `target` and swaps it in, so `target` holds
 * the old contents or the new, never part of either; a crash can leave
 * `<target>.export-<uuid>` or `<target>.previous-<uuid>` beside it. A
 * sibling also keeps the copy out of its own sources, which `cp` refuses.
 * On a failure the previous directory is put back and the first error is
 * thrown. Once the new directory is in place, failing to remove the
 * previous one leaves it beside the target and does not fail the write.
 */
async function replaceDirectory<T>(
  target: string,
  write: (stage: string) => Promise<T>
): Promise<T> {
  await mkdir(dirname(target), { recursive: true });
  const stage = `${target}.export-${randomUUID()}`;
  const previous = `${target}.previous-${randomUUID()}`;
  let movedAside = false;
  let written: T;
  try {
    written = await write(stage);
    if (await statIfPresent(target)) {
      await rename(target, previous);
      movedAside = true;
    }
    await rename(stage, target);
  } catch (error) {
    if (movedAside) {
      await rename(previous, target).catch(ignoreCleanupFailure);
    }
    throw error;
  } finally {
    await rm(stage, { force: true, recursive: true }).catch(
      ignoreCleanupFailure
    );
  }
  if (movedAside) {
    await rm(previous, { force: true, recursive: true }).catch(
      ignoreCleanupFailure
    );
  }
  return written;
}

/** Cleanup is best effort: the error worth reporting is the one that caused it, or none. */
const ignoreCleanupFailure = (): undefined => undefined;
