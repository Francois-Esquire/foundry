import type {
  FileMapDataset,
  FileMapDatasetInput,
  FileMapDatasetOptions,
  FileMapDatasetProgress,
} from "./file-map-dataset";
import { fileMapDataset } from "./file-map-dataset";
import type { RepositoryAcquisitionProgress } from "./github-loader";

// INTERNAL: one owner of file-map scans for a consumer such as a page, with
// at most one scan running and at most one published result. Starting a
// scan aborts the running one; `reset` aborts it and drops the result.
// Each scan captures its identity when it starts and checks it at every
// asynchronous handoff, so a replaced or reset scan never reports progress
// and never publishes: its promise rejects with the abort reason instead.
// A scan may start from a map or from a source that loads one (such as a
// repository loader); the loaded map is handed to analysis only while its
// scan is still current, so a late network response cannot start or
// publish anything.
// No Worker, scheduler or global state; each scanner owns only its own
// scan and result. Not a public export.

/** Why the scanner aborted a scan: a later scan started, or `reset` ran. */
export type FileMapScanEnd = "replaced" | "reset";

/** The abort reason a scanner gives a scan it ends. */
export class FileMapScanAbortedError extends Error {
  readonly end: FileMapScanEnd;

  constructor(end: FileMapScanEnd) {
    super(
      end === "replaced"
        ? "A later scan replaced this one."
        : "The scan was reset."
    );
    this.name = "AbortError";
    this.end = end;
  }
}

/** A step of a scan: loading its source, then analysing the map. */
export type FileMapScanProgress =
  | FileMapDatasetProgress
  | RepositoryAcquisitionProgress;

export interface FileMapScanOptions
  extends Pick<FileMapDatasetOptions, "clock" | "yieldTask"> {
  /** Called only while this scan is the scanner's current one. */
  readonly onProgress?: (progress: FileMapScanProgress) => void;
  /** The caller's own cancellation, beside the scanner's. */
  readonly signal?: AbortSignal;
}

/** What a source loader receives: the scan's signal and its progress channel. */
interface FileMapSourceContext {
  /** Reports only while the scan is current. */
  readonly report: (progress: RepositoryAcquisitionProgress) => void;
  /** Aborts when the scan is replaced, reset or cancelled by its caller. */
  readonly signal: AbortSignal;
}

/** Loads the map a scan analyses; must honor `signal`. */
export type FileMapSource = (
  context: FileMapSourceContext
) => Promise<FileMapDatasetInput>;

export interface FileMapScanner {
  /** The published dataset of the last scan that finished while current. */
  readonly current: FileMapDataset | undefined;
  /** Aborts the running scan, if any, and drops the published dataset. */
  reset(): void;
  /** Whether a scan is running. */
  readonly running: boolean;
  /**
   * Starts a scan, aborting the running one. Resolves with the dataset it
   * publishes as `current`; rejects with the abort reason when it is
   * replaced, reset or aborted, and with the analysis error otherwise. A
   * failed scan leaves no dataset published.
   */
  scan(
    input: FileMapDatasetInput,
    options?: FileMapScanOptions
  ): Promise<FileMapDataset>;
  /**
   * As `scan`, starting from a source that loads the map. The source runs
   * under the scan's signal, and its map is analysed only if the scan is
   * still current when it resolves.
   */
  scanSource(
    source: FileMapSource,
    options?: FileMapScanOptions
  ): Promise<FileMapDataset>;
}

export function createFileMapScanner(): FileMapScanner {
  let active: { controller: AbortController; id: symbol } | undefined;
  let current: FileMapDataset | undefined;
  /**
   * Installs `next` (or nothing) as the active scan, then aborts the one it
   * displaced. Ownership changes before the abort, because abort listeners
   * run synchronously and may start or reset a scan themselves; whatever
   * they install stays installed.
   */
  const displace = (next: typeof active, reason: FileMapScanEnd): void => {
    const previous = active;
    active = next;
    current = undefined;
    previous?.controller.abort(new FileMapScanAbortedError(reason));
  };
  const run = async (
    source: FileMapDatasetInput | FileMapSource,
    options: FileMapScanOptions
  ): Promise<FileMapDataset> => {
    const id = Symbol("file-map scan");
    const controller = new AbortController();
    displace({ controller, id }, "replaced");
    const isCurrent = () => active?.id === id;
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const { onProgress } = options;
    const report = (progress: FileMapScanProgress) => {
      if (isCurrent()) {
        onProgress?.(progress);
      }
    };
    /** A handoff: the scan must still be current and unaborted. */
    const handoff = () => {
      signal.throwIfAborted();
      if (!isCurrent()) {
        throw new FileMapScanAbortedError("replaced");
      }
    };
    try {
      // A listener of the displaced scan may already have replaced this one.
      handoff();
      // A map starts analysis in this same task, as before sources existed.
      const input =
        typeof source === "function"
          ? await source({ report, signal })
          : source;
      handoff();
      const dataset = await fileMapDataset(input, {
        ...(options.clock !== undefined && { clock: options.clock }),
        onProgress: report,
        signal,
        ...(options.yieldTask !== undefined && {
          yieldTask: options.yieldTask,
        }),
      });
      handoff();
      current = dataset;
      return dataset;
    } finally {
      if (isCurrent()) {
        active = undefined;
      }
    }
  };
  return {
    get current() {
      return current;
    },
    reset() {
      displace(undefined, "reset");
    },
    get running() {
      return active !== undefined;
    },
    scan(input, options = {}) {
      return run(input, options);
    },
    scanSource(source, options = {}) {
      return run(source, options);
    },
  };
}
