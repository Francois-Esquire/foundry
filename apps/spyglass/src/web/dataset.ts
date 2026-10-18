import {
  COLLECTION_SCHEMA_VERSION,
  type CollectionManifest,
} from "../lib/collection-types";
import type {
  DatasetReader,
  DatasetReaderOptions,
  DatasetTransport,
} from "../lib/dataset";
import {
  DatasetNotFoundError,
  DatasetReplacedError,
  datasetReader,
} from "../lib/dataset";
import { COLLECTION_MANIFEST } from "../lib/dataset-layout";
import type { DatasetRef } from "./data/types";

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

/** How long a collection's manifest is waited for while a workspace is swapped: attempts, and the longest wait between two. */
const collectionWait = { attempts: 30, longestSeconds: 10 } as const;

function pause(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/**
 * The collection manifest a collection's server or export gives at the
 * data root, read when the data root holds no `manifest.json` (5.3). Not
 * there either: `DatasetNotFoundError`. A `503` means a workspace's dataset
 * is being swapped: it is asked for again after `Retry-After` (1 second if
 * absent), at most 30 times, with `onWait` told the server's reason each
 * time; never reported as no dataset.
 */
export async function readCollectionManifest({
  onWait,
  signal,
}: {
  onWait?: (reason: string) => void;
  signal?: AbortSignal;
} = {}): Promise<CollectionManifest> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${DATA_ROOT}${COLLECTION_MANIFEST}`, {
      cache: "no-store",
      signal,
    });
    if (response.status === 404) {
      throw new DatasetNotFoundError();
    }
    if (response.status === 503 && attempt < collectionWait.attempts) {
      onWait?.(await response.text());
      const after = Number(response.headers.get("Retry-After") ?? "1");
      await pause(
        Math.min(
          collectionWait.longestSeconds,
          Number.isFinite(after) && after >= 0 ? after : 1
        ),
        signal
      );
      continue;
    }
    if (!response.ok) {
      const reason = await response.text();
      throw new Error(
        reason || `Could not load ${COLLECTION_MANIFEST} (${response.status}).`
      );
    }
    let manifest: CollectionManifest;
    try {
      manifest = JSON.parse(await response.text()) as CollectionManifest;
    } catch (error) {
      throw new Error(`Could not parse ${COLLECTION_MANIFEST}.`, {
        cause: error,
      });
    }
    if (manifest.schemaVersion !== COLLECTION_SCHEMA_VERSION) {
      throw new Error(
        `Spyglass reads collection manifest schema version ${COLLECTION_SCHEMA_VERSION}; this one has version ${String(manifest.schemaVersion)}. Serve the collection with this Spyglass.`
      );
    }
    return manifest;
  }
}
