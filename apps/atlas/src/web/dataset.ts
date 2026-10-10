import type {
  DatasetReader,
  DatasetReaderOptions,
  DatasetTransport,
} from "../lib/dataset";
import { datasetReader } from "../lib/dataset";

/** Where the viewer finds its dataset, relative to the page; the server mounts the output here. */
const DATA_ROOT = "./data/";

function fetchTransport(signal?: AbortSignal): DatasetTransport {
  return async (path) => {
    const response = await fetch(`${DATA_ROOT}${path}`, {
      cache: "no-store",
      signal,
    });
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Could not load ${path} (${response.status}).`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Could not parse ${path}.`, { cause: error });
    }
  };
}

/** A reader of the dataset the viewer was served with. */
export function viewerDataset({
  signal,
  ...options
}: DatasetReaderOptions & { signal?: AbortSignal } = {}): DatasetReader {
  return datasetReader(fetchTransport(signal), options);
}
