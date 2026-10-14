import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { processAlive } from "@foundry/lib/file-lock";
import { deleteJournal, verifiedJournal } from "./apply-journal";
import type { CollectionManifestWorkspace } from "./collection-manifest";
import { collectionManifest } from "./collection-manifest";
import type { CollectionManifest, WorkspaceId } from "./collection-types";
import type { DatasetReader, PackageReport } from "./dataset";
import { datasetReader } from "./dataset";
import { fileTransport } from "./dataset-files";
import { HISTORY_DIRECTORY } from "./dataset-layout";
import { packageInternals } from "./internal-analysis";
import type { PackageInternals } from "./internal-analysis-types";
import { analyzePackageLocal } from "./package-local";
import type { SemanticsProgressEvent } from "./semantics";
import { generateSemantics, replaceDirectory } from "./semantics";
import { discoverSemanticsUnits, requireDeclared } from "./semantics-discover";
import type { SemanticsHistoryProgressEvent } from "./semantics-history";
import { generateSemanticsHistory } from "./semantics-history";
import type { HistoryManifest } from "./semantics-history-types";
import type { DatasetManifest, SemanticsConfig } from "./semantics-types";
import { loadConfiguration } from "./spyglass-config";
import type { WorkspaceState } from "./state";
import {
  lockState,
  recordSavedDataset,
  recordWorkspace,
  resolveCollection,
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
  /** The state root (`--state`); each workspace's dataset and cache go in a directory under it. Default `~/.foundry/spyglass`. */
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

/** A workspace scan's own event, wrapped with the workspace of the collection it belongs to. */
export interface CollectionProgressEvent {
  event: ScanProgressEvent;
  /** The workspace id. */
  id: WorkspaceId;
  kind: "workspace";
  /** The workspace root, resolved through symlinks. */
  root: string;
}

export interface CollectionScanOptions extends Omit<ScanOptions, "onProgress"> {
  onProgress?: (event: CollectionProgressEvent) => void;
}

/**
 * What `scan.collection` saved: each workspace's scan, in the collection's
 * order, and the collection manifest derived from their manifests. The
 * collection itself is not saved; `serve.collection` and `spyglass export`
 * derive the manifest again from what is saved then.
 */
export interface CollectionScan {
  manifest: CollectionManifest;
  workspaces: Scan[];
}

/** What a scan saved, before the accessors are attached. */
type Saved = Pick<WorkspaceScan, "history" | "manifest" | "output">;

interface ScanRun {
  config: SemanticsConfig;
  /** A verified apply's journal is waiting for this scan: once the dataset publishes, it goes. */
  finishing?: boolean;
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

/**
 * Scans each workspace of the collection of `roots` as `scan` does, one at a
 * time, in the collection's order, each under its own lock, and derives the
 * collection manifest from the manifests they saved. When one fails, the
 * workspaces scanned before it keep the datasets they saved, and the error
 * names the root that failed, with its own error as the cause and those
 * workspaces' scans as `scanned`.
 */
async function scanCollection(
  roots: readonly string[],
  { onProgress, ...options }: CollectionScanOptions = {}
): Promise<CollectionScan> {
  const workspaces = await resolveCollection(roots, options.state);
  const scans: Scan[] = [];
  const saved: CollectionManifestWorkspace[] = [];
  for (const { id, root } of workspaces) {
    const progress =
      onProgress &&
      ((event: ScanProgressEvent) =>
        onProgress({ event, id, kind: "workspace", root }));
    try {
      // One workspace at a time: each scan already runs its packages in
      // parallel, and its progress stays in one piece.
      const scanned = await scan(root, { ...options, onProgress: progress });
      scans.push(scanned);
      saved.push({ id, manifest: scanned.manifest, root });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(
        new Error(`Spyglass could not scan ${root}: ${message}`, {
          cause: error,
        }),
        { scanned: scans }
      );
    }
  }
  return { manifest: collectionManifest(saved), workspaces: scans };
}

scan.workspace = scanWorkspace;
scan.package = scanPackage;
scan.collection = scanCollection;

/**
 * Runs one scan holding the state directory's lock, which a second scan of
 * the workspace fails to take. Once the lock is held, the state directory
 * gets a workspace record if it has none. An apply interrupted while it
 * wrote is refused, since its sources must be restored first; one that
 * verified its write is finished: once this scan's dataset publishes, its
 * journal goes.
 */
async function whileScanning<T>(
  root: string,
  options: ScanOptions,
  body: (run: ScanRun) => Promise<T>
): Promise<T> {
  const prepared = await prepare(root, options);
  const release = lockState(prepared.state);
  try {
    const run = {
      ...prepared,
      finishing: verifiedJournal(prepared.state) !== undefined,
    };
    removeAbandonedStaging(run.state);
    // No apply runs while this scan holds the lock, so a staged scan left
    // beside the output is an interrupted apply's.
    discardStaged(run.state);
    recordWorkspace(run.state);
    return await body(run);
  } finally {
    release();
  }
}

/**
 * Loads the workspace's configuration, which runs its configuration files:
 * once per call, from the working tree. The scan entry points (`prepare`,
 * `scanPackage`) and `spyglass apply` (`codemod.ts` `applyRecord`, for the
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
  run: ScanRun,
  { internals }: { internals: boolean }
): Promise<DatasetManifest> {
  const output = await generate(run, { internals, output: run.state.output });
  const manifest = await datasetReader(fileTransport(output)).manifest();
  recordSavedDataset(run.state);
  // Published, so the verified write it waited for is finished, even if
  // history fails after this.
  if (run.finishing === true) {
    deleteJournal(run.state);
  }
  return manifest;
}

/** Generates the dataset into `output`, reusing the published one's unchanged artifacts. */
async function generate(
  { config, progress, state }: Pick<ScanRun, "config" | "progress" | "state">,
  { internals, output }: { internals: boolean; output: string }
): Promise<string> {
  const result = await generateSemantics({
    cache: state.cache,
    config,
    failFast: true,
    internals,
    mode: "incremental",
    onProgress: progress,
    output,
    previous: state.output,
    root: state.root,
  });
  return result.output;
}

/** A staging or swap directory, by the process that made it: `output.tmp-<pid>`, `output.next.old-<pid>`, `history.tmp-<pid>`. */
const STAGING = /^(.+?)(\.next)?\.(tmp|old)-(\d+)$/;

/**
 * Removes what a scan or apply that died left beside the output, and
 * history's inside it: staging and swap directories named by a pid that no
 * longer runs. Called
 * under the lock, so no live scan of this workspace owns one.
 */
function removeAbandonedStaging(state: WorkspaceState): void {
  const sweep = (parent: string, name: string) => {
    if (!existsSync(parent)) {
      return;
    }
    for (const entry of readdirSync(parent)) {
      const match = STAGING.exec(entry);
      if (match?.[1] === name && !processAlive(Number(match[4]))) {
        rmSync(join(parent, entry), { force: true, recursive: true });
      }
    }
  };
  sweep(dirname(state.output), basename(state.output));
  // History stages its own directory inside the output: `history.tmp-<pid>`.
  sweep(state.output, HISTORY_DIRECTORY);
}

/** Hardlinks every file under `from` into `to`, copying where the filesystem refuses a link. */
function linkTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      linkTree(source, target);
    } else {
      try {
        linkSync(source, target);
      } catch {
        copyFileSync(source, target);
      }
    }
  }
}

/** Where the scan after a write is staged: beside the output. */
function stagedOutput(state: WorkspaceState): string {
  return `${state.output}.next`;
}

/**
 * The scan after an apply's write, staged, under the lock the apply holds:
 * the dataset, internals included, generated beside the output, reusing the
 * published one's unchanged artifacts, with the saved history carried into
 * it. History covers past commits only, and apply commits nothing, so it
 * still holds; a plain scan without `--history` drops it, as before. The
 * published dataset is untouched: apply verifies its write against the
 * staged reports, then publishes them (`publishStaged`) or discards them
 * (`discardStaged`). Returns the staged directory.
 */
export async function stageAfterWrite(
  state: WorkspaceState,
  config: SemanticsConfig,
  onProgress: (event: ScanProgressEvent) => void = ignoreProgress
): Promise<string> {
  const staged = stagedOutput(state);
  removeAbandonedStaging(state);
  rmSync(staged, { force: true, recursive: true });
  try {
    await generate(
      { config, progress: onProgress, state },
      { internals: true, output: staged }
    );
    const history = join(state.output, HISTORY_DIRECTORY);
    if (existsSync(history)) {
      linkTree(history, join(staged, HISTORY_DIRECTORY));
    }
  } catch (error) {
    discardStaged(state);
    throw error;
  }
  return staged;
}

/** Swaps the staged dataset in and records the save; on a failure the published dataset is as it was. */
export async function publishStaged(
  state: WorkspaceState
): Promise<DatasetManifest> {
  try {
    replaceDirectory(stagedOutput(state), state.output);
  } finally {
    discardStaged(state);
  }
  recordSavedDataset(state);
  return datasetReader(fileTransport(state.output)).manifest();
}

/** Removes a staged dataset that will not be published. */
export function discardStaged(state: WorkspaceState): void {
  rmSync(stagedOutput(state), { force: true, recursive: true });
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
