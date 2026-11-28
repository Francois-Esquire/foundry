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
import { isMissingPath } from "@foundry/lib/node/atomic-file";
import { isFilesystemPathWithin } from "@foundry/lib/paths";
import { refuseUnfinishedApply } from "./apply-journal";
import type { CollectionManifestWorkspace } from "./collection-manifest";
import { collectionManifest } from "./collection-manifest";
import type { CollectionManifest } from "./collection-types";
import { datasetReader } from "./dataset";
import { fileTransport, savedCollection, savedDataset } from "./dataset-files";
import { COLLECTION_MANIFEST, collectionDataset } from "./dataset-layout";
import type { DatasetManifest } from "./semantics-types";
import { viewerRoot } from "./serve";
import type { WorkspaceState } from "./state";
import { lockState, lockStates } from "./state";

const DATA_DIRECTORY = "data";
const MARKER = ".spyglass-static-viewer.json";
const LEGACY_MARKER = ".atlas-static-viewer.json";
const FINDER_FILE = ".DS_Store";

export interface ExportOptions {
  state?: string;
}

export interface StaticViewer {
  directory: string;
  manifest: DatasetManifest;
}

export interface StaticCollectionViewer {
  directory: string;
  manifest: CollectionManifest;
  workspaces: { dataset: string; id: string; root: string }[];
}

interface StaticViewerMarker {
  entries: string[];
}

export async function exportViewer(
  root: string,
  directory: string,
  options: ExportOptions = {}
): Promise<StaticViewer> {
  const viewer = await viewerRoot();
  const { workspace } = await savedDataset(root, options.state);
  const target = resolve(directory);
  await checkPlace(target, [workspace], viewer);
  await checkContents(target);
  const release = lockState(workspace);
  try {
    refuseUnfinishedApply(workspace);
    const manifest = await replaceDirectory(target, async (stage) => {
      await cp(viewer, stage, { recursive: true });
      await cp(await realpath(workspace.output), join(stage, DATA_DIRECTORY), {
        recursive: true,
      });
      await writeMarker(stage);
      return datasetReader(
        fileTransport(join(stage, DATA_DIRECTORY))
      ).manifest();
    });
    return { directory: target, manifest };
  } finally {
    release();
  }
}

export async function exportCollection(
  roots: readonly string[],
  directory: string,
  options: ExportOptions = {}
): Promise<StaticCollectionViewer> {
  const viewer = await viewerRoot();
  const { workspaces } = await savedCollection(roots, options.state);
  const target = resolve(directory);
  await checkPlace(target, workspaces, viewer);
  await checkContents(target);
  const release = lockStates(workspaces);
  try {
    for (const workspace of workspaces) {
      refuseUnfinishedApply(workspace);
    }
    const manifest = await replaceDirectory(target, async (stage) => {
      await cp(viewer, stage, { recursive: true });
      const data = join(stage, DATA_DIRECTORY);
      const copied: CollectionManifestWorkspace[] = [];
      for (const { id, output, root } of workspaces) {
        const copy = join(data, collectionDataset(id));
        await cp(await realpath(output), copy, { recursive: true });
        const saved = await datasetReader(fileTransport(copy)).manifest();
        copied.push({ id, manifest: saved, root });
      }
      const derived = collectionManifest(copied);
      await writeFile(join(data, COLLECTION_MANIFEST), JSON.stringify(derived));
      await writeMarker(stage);
      return derived;
    });
    return {
      directory: target,
      manifest,
      workspaces: workspaces.map(({ id, root }) => ({
        dataset: join(target, DATA_DIRECTORY, id),
        id,
        root,
      })),
    };
  } finally {
    release();
  }
}

async function writeMarker(stage: string): Promise<void> {
  const marker: StaticViewerMarker = {
    entries: (await readdir(stage)).sort(),
  };
  await writeFile(join(stage, MARKER), `${JSON.stringify(marker)}\n`);
}

async function checkPlace(
  target: string,
  workspaces: readonly WorkspaceState[],
  viewer: string
): Promise<void> {
  const real = await resolveThroughLinks(target);
  const refuse = (reason: string): never => {
    throw new Error(`${target} ${reason}. Choose another directory.`);
  };
  for (const workspace of workspaces) {
    if (isFilesystemPathWithin(real, workspace.root, sep)) {
      refuse(`holds the workspace ${workspace.root}`);
    }
    if (overlaps(real, await realpath(workspace.directory))) {
      refuse(`overlaps the state directory ${workspace.directory}`);
    }
  }
  if (overlaps(real, await realpath(viewer))) {
    refuse(`overlaps the viewer's files in ${viewer}`);
  }
}

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

async function checkContents(target: string): Promise<void> {
  const found = await statIfPresent(target);
  if (found === undefined) {
    return;
  }
  if (found.isSymbolicLink()) {
    throw new Error(
      `${target} is a symbolic link; Spyglass does not write through links. Choose another directory.`
    );
  }
  if (!found.isDirectory()) {
    throw new Error(`${target} is not a directory. Choose another directory.`);
  }
  const written = new Set([
    ...((await readMarker(target))?.entries ?? []),
    MARKER,
    LEGACY_MARKER,
    FINDER_FILE,
  ]);
  const extra = (await readdir(target))
    .sort()
    .find((entry) => !written.has(entry));
  if (extra !== undefined) {
    throw new Error(
      `${target} holds files Spyglass did not write, such as ${extra}. Choose another directory.`
    );
  }
}

async function readMarker(
  directory: string
): Promise<StaticViewerMarker | undefined> {
  const current = join(directory, MARKER);
  const path = (await statIfPresent(current))?.isFile()
    ? current
    : join(directory, LEGACY_MARKER);
  if (!(await statIfPresent(path))?.isFile()) {
    return;
  }
  const text = await readFile(path, "utf8");
  let marker: unknown;
  try {
    marker = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
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

const ignoreCleanupFailure = (): undefined => undefined;
