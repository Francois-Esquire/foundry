import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPath } from "@foundry/lib/atomic-file";
import { collectionManifest } from "./collection-manifest";
import type { CollectionManifest, WorkspaceId } from "./collection-types";
import type { DatasetReader, DatasetTransport } from "./dataset";
import { DatasetNotFoundError, datasetReader } from "./dataset";
import type { DatasetManifest } from "./semantics-types";
import type { WorkspaceState } from "./state";
import { resolveCollection, workspaceState } from "./state";

/** A workspace's saved dataset: where its state directory keeps it, and a reader. */
export interface SavedDataset {
  /** One read of the dataset, its manifest already read and checked. */
  reader: DatasetReader;
  workspace: WorkspaceState;
}

/**
 * A collection's saved datasets: its workspaces, each one's output by id,
 * and its collection manifest, derived from the manifests saved when it is
 * called, so a scan of one workspace meanwhile is seen at the next call.
 * The server's mount table (`startServer`'s `collection`).
 */
export interface SavedCollection {
  /** Each workspace's output, by workspace id. */
  datasets: ReadonlyMap<WorkspaceId, string>;
  manifest(): Promise<CollectionManifest>;
  /** In the collection's order. */
  workspaces: readonly WorkspaceState[];
}

/** Reads a dataset saved in `output` from the file system. */
export function fileTransport(output: string): DatasetTransport {
  return async (path) => {
    let text: string;
    try {
      text = await readFile(join(output, path), "utf8");
    } catch (error) {
      if (isMissingPath(error)) {
        return;
      }
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Could not parse ${path}.`, { cause: error });
    }
  };
}

/**
 * The dataset a scan saved for the workspace at `root`, under the state root
 * `state`. Reads and checks the manifest, so it fails at once, naming the
 * workspace and the directory, when nothing is saved; creates nothing.
 */
export async function savedDataset(
  root: string,
  state?: string
): Promise<SavedDataset> {
  return checkedDataset(await workspaceState(root, state));
}

/**
 * The datasets scans saved for the collection of `roots`, each checked as
 * `savedDataset` checks one, in the collection's order, so the first
 * workspace with no dataset is named. Creates nothing.
 */
export async function savedCollection(
  roots: readonly string[],
  state?: string
): Promise<SavedCollection> {
  const workspaces = await resolveCollection(roots, state);
  for (const workspace of workspaces) {
    // In order, so the message names the first workspace without a dataset.
    await checkedDataset(workspace);
  }
  return {
    datasets: new Map(workspaces.map(({ id, output }) => [id, output])),
    manifest: async () =>
      collectionManifest(
        await Promise.all(
          workspaces.map(async (workspace) => ({
            id: workspace.id,
            manifest: await savedManifest(workspace),
            root: workspace.root,
          }))
        )
      ),
    workspaces,
  };
}

/**
 * The workspace's saved manifest, read now. A failure names the workspace:
 * `checkedDataset`'s message when nothing is saved (the dataset deleted, or
 * caught mid-swap), and otherwise the reader's, after the workspace's root.
 */
async function savedManifest(
  workspace: WorkspaceState
): Promise<DatasetManifest> {
  try {
    return await (await checkedDataset(workspace)).reader.manifest();
  } catch (error) {
    if (error instanceof DatasetNotFoundError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workspace ${workspace.root}: ${message}`, {
      cause: error,
    });
  }
}

async function checkedDataset(
  workspace: WorkspaceState
): Promise<SavedDataset> {
  const reader = datasetReader(fileTransport(workspace.output));
  try {
    await reader.manifest();
  } catch (error) {
    if (error instanceof DatasetNotFoundError) {
      throw new DatasetNotFoundError(
        `No dataset found for ${workspace.root} in ${workspace.output}. Run atlas scan to save one.`,
        { cause: error }
      );
    }
    throw error;
  }
  return { reader, workspace };
}
