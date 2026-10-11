import type {
  DatasetReader,
  DatasetReaderOptions,
  DatasetTransport,
} from "../lib/dataset";
import { DatasetReplacedError, datasetReader } from "../lib/dataset";

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

/** What the viewer says when a read after load finds a later scan's dataset. */
export const REPLACED_MESSAGE =
  "A later scan replaced this dataset. Reload to see it.";

/**
 * A read after load, pinned to the dataset the map was laid out from: a
 * dataset a later scan replaced fails with `REPLACED_MESSAGE`, which tells
 * the reader what to do; any other failure as it is.
 */
export async function pinnedRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof DatasetReplacedError) {
      throw new Error(REPLACED_MESSAGE, { cause: error });
    }
    throw error;
  }
}

/** A reader of the dataset the viewer was served with. */
export function viewerDataset({
  signal,
  ...options
}: DatasetReaderOptions & { signal?: AbortSignal } = {}): DatasetReader {
  return datasetReader(fetchTransport(signal), options);
}
