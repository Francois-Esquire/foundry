import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackageInternals } from "./internal-analysis";
import { packageInternals } from "./internal-analysis";
import { analyzePackageLocal } from "./package-local";
import type { SemanticsProgressEvent } from "./semantics";
import { generateSemantics } from "./semantics";
import {
  discoverSemanticsUnits,
  loadSemanticsConfig,
} from "./semantics-discover";
import type { SemanticsHistoryProgressEvent } from "./semantics-history";
import { generateSemanticsHistory } from "./semantics-history";
import type { SemanticsHistoryManifest } from "./semantics-history-types";
import type { SemanticsConfig, SemanticsManifest } from "./semantics-types";
import type { WorkspaceState } from "./state";
import {
  lockState,
  recordSavedDataset,
  recordWorkspace,
  resolveRoot,
  workspaceState,
} from "./state";

export type { PackageInternals } from "./internal-analysis";

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

/** What a workspace scan saved: the directory the dataset is in, and its manifest. */
export interface WorkspaceScan {
  history?: { manifest: SemanticsHistoryManifest };
  manifest: SemanticsManifest;
  /** The directory the dataset is saved in. */
  output: string;
}

/** What `scan` saved: a workspace scan whose dataset also holds every complete package's internals. */
export interface Scan extends WorkspaceScan {}

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
    withHistory(run, await publish(run, { internals: true }))
  );
}

/** Scans the workspace level only and saves the dataset, without internals. */
function scanWorkspace(
  root: string,
  options: ScanOptions = {}
): Promise<WorkspaceScan> {
  return whileScanning(root, options, async (run) =>
    withHistory(run, await publish(run, { internals: false }))
  );
}

/** One package's internals, analyzed fresh. Saves nothing. */
async function scanPackage(
  root: string,
  name: string
): Promise<PackageInternals> {
  const resolved = await resolveRoot(root);
  const found = discoverSemanticsUnits(
    resolved,
    loadSemanticsConfig(resolved)
  ).units.find((unit) => unit.id === name);
  if (found === undefined) {
    throw new Error(
      `Workspace ${resolved} has no package named ${name} under its roots.`
    );
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

async function prepare(root: string, options: ScanOptions): Promise<ScanRun> {
  const state = await workspaceState(root, options.state);
  return {
    config: { ...loadSemanticsConfig(state.root), output: state.output },
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
): Promise<SemanticsManifest> {
  const result = await generateSemantics({
    cache: state.cache,
    config,
    failFast: true,
    internals,
    mode: "incremental",
    onProgress: progress,
    root: state.root,
  });
  const manifest = JSON.parse(
    await readFile(result.manifest, "utf8")
  ) as SemanticsManifest;
  recordSavedDataset(state);
  return manifest;
}

/** The scan's result, after saving history into the dataset when the scan asks for it. */
async function withHistory(
  { config, history, progress, state }: ScanRun,
  manifest: SemanticsManifest
): Promise<WorkspaceScan> {
  const saved = { manifest, output: state.output };
  if (!history) {
    return saved;
  }
  const historical = await generateSemanticsHistory({
    cache: join(state.cache, "history"),
    config,
    onProgress: (event) => progress({ event, kind: "history" }),
    output: join(state.output, "history"),
    root: state.root,
  });
  if (historical.manifest.generation.failedSnapshots) {
    throw new Error("Some history checkpoints failed analysis.");
  }
  return { ...saved, history: { manifest: historical.manifest } };
}
