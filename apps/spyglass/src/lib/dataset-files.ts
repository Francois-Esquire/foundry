import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPath } from "@foundry/lib/atomic-file";
import { collectionManifest } from "./collection-manifest";
import type { CollectionManifest, WorkspaceId } from "./collection-types";
import type { DatasetReader, DatasetTransport } from "./dataset";
import { DatasetNotFoundError, datasetReader } from "./dataset";
import { DATASET_FILES } from "./dataset-layout";
import type { DatasetManifest } from "./semantics-types";
import type { WorkspaceState } from "./state";
import { resolveCollection, workspaceState } from "./state";
import { readPreparedVisualization } from "./visualization/schema";
import type { PreparedVisualization } from "./visualization/types";

export interface SavedDataset {
  reader: DatasetReader;
  workspace: WorkspaceState;
}

export interface SavedCollection {
  datasets: ReadonlyMap<WorkspaceId, string>;
  manifest(): Promise<CollectionManifest>;

  workspaces: readonly WorkspaceState[];
}

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

export async function previousVisualization(
  previous: string | undefined
): Promise<PreparedVisualization | undefined> {
  if (previous === undefined) {
    return;
  }
  try {
    const read = fileTransport(previous);
    const manifest = (await read(DATASET_FILES.manifest)) as
      | DatasetManifest
      | undefined;
    const path = manifest?.files?.visualization;
    return path === undefined
      ? undefined
      : readPreparedVisualization(await read(path));
  } catch {
    // Invalid cached output must not prevent a new scan.
  }
}

export async function savedDataset(
  root: string,
  state?: string
): Promise<SavedDataset> {
  return checkedDataset(await workspaceState(root, state));
}

export async function savedCollection(
  roots: readonly string[],
  state?: string
): Promise<SavedCollection> {
  const workspaces = await resolveCollection(roots, state);
  for (const workspace of workspaces) {
    await savedManifest(workspace);
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
        `No dataset found for ${workspace.root} in ${workspace.output}. Run spyglass scan to save one.`,
        { cause: error }
      );
    }
    throw error;
  }
  return { reader, workspace };
}
