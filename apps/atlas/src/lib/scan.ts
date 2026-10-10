import { join } from "node:path";
import { loadConfiguration } from "./atlas-config";
import type { DatasetReader, PackageReport } from "./dataset";
import { datasetReader } from "./dataset";
import { fileTransport } from "./dataset-files";
import { HISTORY_DIRECTORY } from "./dataset-layout";
import { packageInternals } from "./internal-analysis";
import type { PackageInternals } from "./internal-analysis-types";
import { analyzePackageLocal } from "./package-local";
import type { SemanticsProgressEvent } from "./semantics";
import { generateSemantics } from "./semantics";
import { discoverSemanticsUnits, requireDeclared } from "./semantics-discover";
import type { SemanticsHistoryProgressEvent } from "./semantics-history";
import { generateSemanticsHistory } from "./semantics-history";
import type { HistoryManifest } from "./semantics-history-types";
import type { DatasetManifest, SemanticsConfig } from "./semantics-types";
import type { WorkspaceState } from "./state";
import {
  lockState,
  recordSavedDataset,
  recordWorkspace,
  resolveRoot,
  workspaceState,
} from "./state";
import type { WorkspaceReport } from "./workspace-types";

export type ScanProgressEvent =
  | SemanticsProgressEvent
  /** History's own events, wrapped because their kinds overlap the scan's. */
  | { kind: "history"; event: SemanticsHistoryProgressEvent };

export interface ScanOptions {
  /** Also analyze Git checkpoints into the dataset's `history/`. */
  history?: boolean;
  onProgress?: (event: ScanProgressEvent) => void;
  /** The state root (`--state`); each workspace's dataset and cache go in a directory under it. Default `~/.foundry/atlas`. */
  state?: string;
}

/**
 * What a workspace scan saved: the directory the dataset is in, its manifest,
 * and accessors for the rest. Each accessor reads the saved dataset when
 * called (the manifest, one file, and the manifest again) and fails with
 * `DatasetReplacedError` once another scan has saved over it. The plain
 * fields are JSON; `JSON.stringify` leaves the accessors out.
 */
export interface WorkspaceScan {
  history?: { manifest: HistoryManifest };
  manifest: DatasetManifest;
  /** The directory the dataset is saved in. */
  output: string;
  /** One package's report, as the dataset saved it. */
  packageReport(name: string): Promise<PackageReport>;
  /** The workspace report, as the dataset saved it. */
  workspaceReport(): Promise<WorkspaceReport>;
}

/** What `scan` saved: a workspace scan whose dataset also holds every complete package's internals. */
export interface Scan extends WorkspaceScan {
  /** One package's internals, as the dataset saved them; `scan.package` analyzes them fresh instead. */
  internals(name: string): Promise<PackageInternals>;
}

/** What a scan saved, before the accessors are attached. */
type Saved = Pick<WorkspaceScan, "history" | "manifest" | "output">;

interface ScanRun {
  config: SemanticsConfig;
  history: boolean;
  progress: (event: ScanProgressEvent) => void;
  state: WorkspaceState;
}

const ignoreProgress = (): void => undefined;

/** Scans the workspace and every complete package's internals, and saves the dataset. */
export function scan(root: string, options: ScanOptions = {}): Promise<Scan> {
  return whileScanning(root, options, async (run) =>
    savedScan(await withHistory(run, await publish(run, { internals: true })))
  );
}

/** Scans the workspace level only and saves the dataset, without internals. */
function scanWorkspace(
  root: string,
  options: ScanOptions = {}
): Promise<WorkspaceScan> {
  return whileScanning(root, options, async (run) =>
    savedWorkspace(
      await withHistory(run, await publish(run, { internals: false }))
    )
  );
}

/** One package's internals, analyzed fresh. Saves nothing. */
async function scanPackage(
  root: string,
  name: string
): Promise<PackageInternals> {
  const resolved = await resolveRoot(root);
  const discovery = requireDeclared(
    resolved,
    discoverSemanticsUnits(resolved, await loadConfiguration(resolved))
  );
  const found = discovery.units.find((unit) => unit.id === name);
  if (found === undefined) {
    throw new Error(`Workspace ${resolved} has no package named ${name}.`);
  }
  return packageInternals(
    analyzePackageLocal({ root: resolved, target: found.path })
  );
}

scan.workspace = scanWorkspace;
scan.package = scanPackage;

/**
 * Runs one scan holding the state directory's lock, which a second scan of
 * the workspace fails to take. Once the lock is held, the state directory
 * gets a workspace record if it has none.
 */
async function whileScanning<T>(
  root: string,
  options: ScanOptions,
  body: (run: ScanRun) => Promise<T>
): Promise<T> {
  const run = await prepare(root, options);
  const release = lockState(run.state);
  try {
    recordWorkspace(run.state);
    return await body(run);
  } finally {
    release();
  }
}

/**
 * Loads the workspace's configuration, which runs its configuration files:
 * once per call, from the working tree. The scan entry points (`prepare`,
 * `scanPackage`) and `atlas apply` (`codemod.ts` `applyRecord`, for the
 * rules it authorizes under) are the only load sites; history applies the
 * configuration to every checkpoint, and nothing else loads it. `plan` and
 * `check` read the rules the last scan saved instead.
 */
async function prepare(root: string, options: ScanOptions): Promise<ScanRun> {
  const state = await workspaceState(root, options.state);
  return {
    config: await loadConfiguration(state.root),
    history: options.history === true,
    progress: options.onProgress ?? ignoreProgress,
    state,
  };
}

/**
 * The workspace dataset, with every complete package's internals when asked,
 * published. A failed package publishes nothing. The workspace record notes
 * the save at once, so a later history failure leaves a record that matches
 * the saved dataset.
 */
async function publish(
  { config, progress, state }: ScanRun,
  { internals }: { internals: boolean }
): Promise<DatasetManifest> {
  const result = await generateSemantics({
    cache: state.cache,
    config,
    failFast: true,
    internals,
    mode: "incremental",
    onProgress: progress,
    output: state.output,
    root: state.root,
  });
  const manifest = await datasetReader(fileTransport(result.output)).manifest();
  recordSavedDataset(state);
  return manifest;
}

/** The scan's result, after saving history into the dataset when the scan asks for it. */
async function withHistory(
  { config, history, progress, state }: ScanRun,
  manifest: DatasetManifest
): Promise<Saved> {
  const saved = { manifest, output: state.output };
  if (!history) {
    return saved;
  }
  const historical = await generateSemanticsHistory({
    cache: join(state.cache, "history"),
    config,
    onProgress: (event) => progress({ event, kind: "history" }),
    output: join(state.output, HISTORY_DIRECTORY),
    root: state.root,
  });
  if (historical.manifest.generation.failedSnapshots) {
    throw new Error("Some history checkpoints failed analysis.");
  }
  return { ...saved, history: { manifest: historical.manifest } };
}

/**
 * Reads the saved dataset through a fresh reader pinned to the manifest this
 * scan saved, then reads the manifest again, so a scan that replaces the
 * dataset mid-read cannot mix two datasets.
 */
function pinned(saved: Saved) {
  const reader = () =>
    datasetReader(fileTransport(saved.output), {
      pin: saved.manifest.generatedAt,
    });
  return async <T>(
    read: (dataset: DatasetReader) => Promise<T>
  ): Promise<T> => {
    const value = await read(reader());
    await reader().manifest();
    return value;
  };
}

/** The saved dataset with the workspace-level accessors attached. */
function savedWorkspace(saved: Saved): WorkspaceScan {
  const read = pinned(saved);
  return {
    ...saved,
    packageReport: (name) => read((dataset) => dataset.packageReport(name)),
    workspaceReport: () => read((dataset) => dataset.workspaceReport()),
  };
}

/** A full scan's dataset also holds internals, so it gains their accessor. */
function savedScan(saved: Saved): Scan {
  const read = pinned(saved);
  return {
    ...savedWorkspace(saved),
    internals: (name) => read((dataset) => dataset.internals(name)),
  };
}
