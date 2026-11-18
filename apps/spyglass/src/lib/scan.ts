import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { processAlive } from "@foundry/lib/process-identity";
import { deleteJournal, verifiedJournal } from "./apply-journal";
import type { CollectionManifestWorkspace } from "./collection-manifest";
import { collectionManifest } from "./collection-manifest";
import type { CollectionManifest, WorkspaceId } from "./collection-types";
import type { DatasetReader, PackageReport } from "./dataset";
import { datasetReader } from "./dataset";
import { fileTransport } from "./dataset-files";
import { HISTORY_DIRECTORY } from "./dataset-layout";
import {
  discardDirectory,
  recoverDirectory,
  replaceDirectory,
} from "./directory-publication";
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
  | { kind: "history"; event: SemanticsHistoryProgressEvent };

export interface ScanOptions {
  history?: boolean;
  onProgress?: (event: ScanProgressEvent) => void;
  state?: string;
}

export interface WorkspaceScan {
  history?: { manifest: HistoryManifest };
  manifest: DatasetManifest;
  output: string;
  packageReport(name: string): Promise<PackageReport>;
  workspaceReport(): Promise<WorkspaceReport>;
}

export interface Scan extends WorkspaceScan {
  internals(name: string): Promise<PackageInternals>;
}

export interface CollectionProgressEvent {
  event: ScanProgressEvent;
  id: WorkspaceId;
  kind: "workspace";
  root: string;
}

export interface CollectionScanOptions extends Omit<ScanOptions, "onProgress"> {
  onProgress?: (event: CollectionProgressEvent) => void;
}

export interface CollectionScan {
  manifest: CollectionManifest;
  workspaces: Scan[];
}

type Saved = Pick<WorkspaceScan, "history" | "manifest" | "output">;

interface ScanRun {
  config: SemanticsConfig;
  finishing?: boolean;
  history: boolean;
  progress: (event: ScanProgressEvent) => void;
  state: WorkspaceState;
}

const ignoreProgress = (): void => undefined;

export function scan(root: string, options: ScanOptions = {}): Promise<Scan> {
  return whileScanning(root, options, async (run) =>
    savedScan(await withHistory(run, await publish(run, { internals: true })))
  );
}

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
    recoverDirectory(run.state.output);
    removeAbandonedStaging(run.state);
    discardStaged(run.state);
    recordWorkspace(run.state);
    return await body(run);
  } finally {
    release();
  }
}

async function prepare(root: string, options: ScanOptions): Promise<ScanRun> {
  const state = await workspaceState(root, options.state);
  return {
    config: await loadConfiguration(state.root),
    history: options.history === true,
    progress: options.onProgress ?? ignoreProgress,
    state,
  };
}

async function publish(
  run: ScanRun,
  { internals }: { internals: boolean }
): Promise<DatasetManifest> {
  const output = await generate(run, { internals, output: run.state.output });
  const manifest = await datasetReader(fileTransport(output)).manifest();
  recordSavedDataset(run.state);
  if (run.finishing === true) {
    deleteJournal(run.state);
  }
  return manifest;
}

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

const STAGING = /^(.+?)(\.next)?\.(tmp|old)-(\d+)$/;

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
  sweep(state.output, HISTORY_DIRECTORY);
}

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

function stagedOutput(state: WorkspaceState): string {
  return `${state.output}.next`;
}

export async function stageAfterWrite(
  state: WorkspaceState,
  config: SemanticsConfig,
  onProgress: (event: ScanProgressEvent) => void = ignoreProgress
): Promise<string> {
  const staged = stagedOutput(state);
  removeAbandonedStaging(state);
  discardDirectory(staged);
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

export function discardStaged(state: WorkspaceState): void {
  discardDirectory(stagedOutput(state));
}

async function withHistory(
  { config, history, progress, state }: ScanRun,
  manifest: DatasetManifest
): Promise<Saved> {
  const saved = { manifest, output: state.output };
  if (!history) {
    return saved;
  }
  const scratch = mkdtempSync(join(state.directory, "history-"));
  try {
    const historical = await generateSemanticsHistory({
      cache: join(state.cache, "history"),
      config,
      onProgress: (event) => progress({ event, kind: "history" }),
      output: join(scratch, "history"),
      root: state.root,
    });
    if (historical.manifest.generation.failedSnapshots) {
      throw new Error("Some history checkpoints failed analysis.");
    }
    const stage = join(scratch, "dataset");
    cpSync(realpathSync(state.output), stage, { recursive: true });
    rmSync(join(stage, HISTORY_DIRECTORY), { force: true, recursive: true });
    cpSync(
      realpathSync(join(scratch, "history")),
      join(stage, HISTORY_DIRECTORY),
      {
        recursive: true,
      }
    );
    replaceDirectory(stage, state.output);
    return { ...saved, history: { manifest: historical.manifest } };
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

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

function savedWorkspace(saved: Saved): WorkspaceScan {
  const read = pinned(saved);
  return {
    ...saved,
    packageReport: (name) => read((dataset) => dataset.packageReport(name)),
    workspaceReport: () => read((dataset) => dataset.workspaceReport()),
  };
}

function savedScan(saved: Saved): Scan {
  const read = pinned(saved);
  return {
    ...savedWorkspace(saved),
    internals: (name) => read((dataset) => dataset.internals(name)),
  };
}
