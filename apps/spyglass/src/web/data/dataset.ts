import type {
  DatasetReader,
  DatasetReaderOptions,
  DatasetTransport,
} from "../../lib/dataset";
import { DatasetReplacedError, datasetReader } from "../../lib/dataset";
import { COLLECTION_MANIFEST } from "../../lib/dataset-layout";
import type { DatasetRef } from "./types";

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

export const REPLACED_MESSAGE =
  "A later scan replaced this dataset. Reload to see it.";

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

export function viewerDataset({
  dataset,
  signal,
  ...options
}: DatasetReaderOptions & {
  dataset?: DatasetRef;
  signal?: AbortSignal;
} = {}): DatasetReader {
  const transport =
    dataset?.transport ?? fetchTransport(dataset?.root ?? "", signal);
  return datasetReader(transport, {
    ...options,
    ...(dataset && { pin: dataset.generatedAt }),
  });
}

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
