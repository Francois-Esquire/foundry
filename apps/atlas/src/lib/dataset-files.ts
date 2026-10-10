import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPath } from "@foundry/lib/atomic-file";
import type { DatasetReader, DatasetTransport } from "./dataset";
import { DatasetNotFoundError, datasetReader } from "./dataset";
import type { WorkspaceState } from "./state";
import { workspaceState } from "./state";

/** A workspace's saved dataset: where its state directory keeps it, and a reader. */
export interface SavedDataset {
  /** One read of the dataset, its manifest already read and checked. */
  reader: DatasetReader;
  workspace: WorkspaceState;
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
  const workspace = await workspaceState(root, state);
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
