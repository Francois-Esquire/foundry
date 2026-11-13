import type { DatasetTransport } from "../dataset";
import { datasetReader } from "../dataset";
import { DATASET_FILES } from "../dataset-layout";
import type { DatasetManifest } from "../semantics-types";
import { prepareVisualization } from "./prepare";
import { readVisualizationInput } from "./read";
import type { PreparedVisualization } from "./types";

interface WriteVisualizationOptions {
  draft: DatasetManifest;
  /**
   * The previous dataset's visualization, a disposable cache whose geometry
   * is reused when its input is unchanged. Read by the caller; a missing or
   * invalid one resolves to `undefined`.
   */
  previous?: Promise<PreparedVisualization | undefined>;
  /** Reads the unpublished tree; the manifest is answered by `draft`. */
  read: DatasetTransport;
  write: (file: string, value: unknown) => void;
}

/** Prepare after lenses; publish with the same atomic dataset swap as the analysis. */
export async function writeVisualization(
  options: WriteVisualizationOptions
): Promise<void> {
  const files = options.read;
  const reader = datasetReader((path) =>
    path === DATASET_FILES.manifest
      ? Promise.resolve(options.draft)
      : files(path)
  );
  const [input, previous] = await Promise.all([
    readVisualizationInput(reader),
    options.previous,
  ]);
  options.write(
    DATASET_FILES.visualization,
    prepareVisualization(input, undefined, previous)
  );
}
