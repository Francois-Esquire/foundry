import { datasetReader } from "../dataset";
import { fileTransport } from "../dataset-files";
import { DATASET_FILES } from "../dataset-layout";
import type { DatasetManifest } from "../semantics-types";
import { prepareVisualization } from "./prepare";
import { readVisualizationInput } from "./read";
import { readPreparedVisualization } from "./schema";
import type { PreparedVisualization } from "./types";

interface WriteVisualizationOptions {
  dir: string;
  draft: DatasetManifest;
  previous?: string;
  write: (file: string, value: unknown) => void;
}

/** A previous visualization is a disposable cache; rescanning repairs corrupt cache files. */
async function previousVisualization(
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
    // Invalid previous output must not prevent a new scan from repairing it.
  }
}

/** Prepare after lenses; publish with the same atomic dataset swap as the analysis. */
export async function writeVisualization(
  options: WriteVisualizationOptions
): Promise<void> {
  const files = fileTransport(options.dir);
  const reader = datasetReader((path) =>
    path === DATASET_FILES.manifest
      ? Promise.resolve(options.draft)
      : files(path)
  );
  const [input, previous] = await Promise.all([
    readVisualizationInput(reader),
    previousVisualization(options.previous),
  ]);
  options.write(
    DATASET_FILES.visualization,
    prepareVisualization(input, undefined, previous)
  );
}
