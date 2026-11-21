import type { DatasetTransport } from "../dataset";
import { datasetReader } from "../dataset";
import { DATASET_FILES } from "../dataset-layout";
import type { DatasetManifest } from "../semantics-types";
import { prepareVisualization } from "./prepare";
import { readVisualizationInput } from "./read";
import type { PreparedVisualization } from "./types";

interface WriteVisualizationOptions {
  draft: DatasetManifest;

  previous?: Promise<PreparedVisualization | undefined>;

  read: DatasetTransport;
  write: (file: string, value: unknown) => void;
}

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
