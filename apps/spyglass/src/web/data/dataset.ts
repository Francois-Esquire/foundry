import type {
  DatasetReader,
  DatasetReaderOptions,
  DatasetTransport,
} from "../../lib/dataset";
import { DatasetReplacedError, datasetReader } from "../../lib/dataset";
import { COLLECTION_MANIFEST } from "../../lib/dataset-layout";
import type { DatasetRef } from "./types";

/** Where the viewer finds its dataset, relative to the page; the server mounts the output here. */
const DATA_ROOT = "./data/";

function fetchTransport(root: string, signal?: AbortSignal): DatasetTransport {
  return async (path) => {
    const response = await fetch(`${DATA_ROOT}${root}${path}`, {
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

/**
 * A reader of a dataset the viewer was served with: the one at the data
 * root, or, given `dataset`, that workspace's, pinned to its `generatedAt`.
 */
export function viewerDataset({
  dataset,
  signal,
  ...options
}: DatasetReaderOptions & {
  dataset?: DatasetRef;
  signal?: AbortSignal;
} = {}): DatasetReader {
  return datasetReader(fetchTransport(dataset?.root ?? "", signal), {
    ...options,
    ...(dataset && { pin: dataset.generatedAt }),
  });
}

/**
 * Whether the data root serves a collection rather than one workspace,
 * asked when it holds no `manifest.json`: one `HEAD` of the collection
 * manifest (5.3), so nothing the viewer refuses is read. A `503` (a
 * workspace's dataset being swapped) is a collection's too.
 */
export async function servesCollection(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(`${DATA_ROOT}${COLLECTION_MANIFEST}`, {
    cache: "no-store",
    method: "HEAD",
    signal,
  });
  if (response.status === 404) {
    return false;
  }
  if (response.ok || response.status === 503) {
    return true;
  }
  throw new Error(
    `Could not load ${COLLECTION_MANIFEST} (${response.status}).`
  );
}
