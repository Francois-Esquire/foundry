import type {
  FileMapDataset,
  FileMapDatasetInput,
  FileMapDatasetOptions,
  FileMapDatasetProgress,
} from "./file-map-dataset";
import { fileMapDataset } from "./file-map-dataset";
import type { RepositoryAcquisitionProgress } from "./github-loader";

export type FileMapScanEnd = "replaced" | "reset";

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

export type FileMapScanProgress =
  | FileMapDatasetProgress
  | RepositoryAcquisitionProgress;

export interface FileMapScanOptions
  extends Pick<FileMapDatasetOptions, "clock" | "yieldTask"> {
  readonly onProgress?: (progress: FileMapScanProgress) => void;

  readonly signal?: AbortSignal;
}

interface FileMapSourceContext {
  readonly report: (progress: RepositoryAcquisitionProgress) => void;

  readonly signal: AbortSignal;
}

export type FileMapSource = (
  context: FileMapSourceContext
) => Promise<FileMapDatasetInput>;

export interface FileMapScanner {
  readonly current: FileMapDataset | undefined;

  reset(): void;

  readonly running: boolean;

  scan(
    input: FileMapDatasetInput,
    options?: FileMapScanOptions
  ): Promise<FileMapDataset>;

  scanSource(
    source: FileMapSource,
    options?: FileMapScanOptions
  ): Promise<FileMapDataset>;
}

export function createFileMapScanner(): FileMapScanner {
  let active: { controller: AbortController; id: symbol } | undefined;
  let current: FileMapDataset | undefined;
  // Transfer ownership before aborting because abort listeners can synchronously replace the scan.
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

    const handoff = () => {
      signal.throwIfAborted();
      if (!isCurrent()) {
        throw new FileMapScanAbortedError("replaced");
      }
    };
    try {
      handoff();

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
