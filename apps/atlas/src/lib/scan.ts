import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInternalAnalysis } from "./internal-analysis";
import type { SemanticsProgressEvent } from "./semantics";
import { encodePackageFile, generateSemantics } from "./semantics";
import { writeJsonAtomic } from "./semantics-cache";
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

export type ScanProgressEvent =
  | SemanticsProgressEvent
  /** Before one package's internals are analyzed, after the dataset is saved. */
  | {
      kind: "internals";
      package: string;
      /** The package's position, 1-based, of `total`. */
      index: number;
      total: number;
    }
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

type InternalAnalysis = ReturnType<typeof runInternalAnalysis>;

/** One package's internal structure, every stage through the review. */
export interface PackageInternals {
  locality: NonNullable<InternalAnalysis["locality"]>;
  primitives: NonNullable<InternalAnalysis["primitives"]>;
  responsibilities: NonNullable<InternalAnalysis["responsibilities"]>;
  review: NonNullable<InternalAnalysis["review"]>;
  rewiring: NonNullable<InternalAnalysis["rewiring"]>;
  topology: InternalAnalysis["topology"];
}

interface ScanRun {
  config: SemanticsConfig;
  history: boolean;
  progress: (event: ScanProgressEvent) => void;
  state: WorkspaceState;
}

const ignoreProgress = (): void => undefined;

/** Scans the workspace and every complete package's internals, and saves the dataset. */
export function scan(root: string, options: ScanOptions = {}): Promise<Scan> {
  return whileScanning(root, options, async (run) => {
    const manifest = await publishWorkspace(run);
    await saveInternals(run, manifest);
    return await withHistory(run, manifest);
  });
}

/** Scans the workspace level only and saves the dataset, without internals. */
function scanWorkspace(
  root: string,
  options: ScanOptions = {}
): Promise<WorkspaceScan> {
  return whileScanning(root, options, async (run) => {
    const manifest = await publishWorkspace(run);
    return await withHistory(run, manifest);
  });
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
  return completeInternals(
    name,
    runInternalAnalysis({
      root: resolved,
      target: found.path,
      through: "review",
    })
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
 * The workspace dataset, published, plus every package's declared manifest.
 * The workspace record notes the save at once, so a later internals or
 * history failure leaves a record that matches the saved dataset.
 */
async function publishWorkspace({
  config,
  progress,
  state,
}: ScanRun): Promise<SemanticsManifest> {
  const result = await generateSemantics({
    cache: state.cache,
    config,
    failFast: true,
    mode: "incremental",
    onProgress: progress,
    root: state.root,
  });
  if (result.packages.failed) {
    throw new Error(`${result.packages.failed} packages failed analysis.`);
  }
  const manifest = JSON.parse(
    await readFile(result.manifest, "utf8")
  ) as SemanticsManifest;
  await mkdir(join(state.output, "manifests"), { recursive: true });
  for (const pkg of manifest.packages) {
    await copyFile(
      join(state.root, pkg.path, "package.json"),
      join(state.output, "manifests", `${encodePackageFile(pkg.id)}.json`)
    );
  }
  recordSavedDataset(state);
  return manifest;
}

/** Every complete package's internals, written into the published dataset. */
async function saveInternals(
  { progress, state }: ScanRun,
  manifest: SemanticsManifest
): Promise<void> {
  // Keeps an empty internals/ when no package is complete, as before.
  await mkdir(join(state.output, "internals"), { recursive: true });
  const complete = manifest.packages.filter((pkg) => pkg.status === "complete");
  for (const [index, pkg] of complete.entries()) {
    progress({
      index: index + 1,
      kind: "internals",
      package: pkg.id,
      total: complete.length,
    });
    writeJsonAtomic(
      join(state.output, "internals", `${encodePackageFile(pkg.id)}.json`),
      runInternalAnalysis({
        root: state.root,
        target: pkg.path,
        through: "review",
      })
    );
  }
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

/** The same check web/load-internals.ts makes; the reader in 1.5 owns it. */
function completeInternals(
  name: string,
  analysis: InternalAnalysis
): PackageInternals {
  const { topology, locality, responsibilities, primitives, rewiring, review } =
    analysis;
  if (
    topology.package.id !== name ||
    !locality ||
    !responsibilities ||
    !primitives ||
    !rewiring ||
    !review
  ) {
    throw new Error(`Incomplete internals for ${name}.`);
  }
  return { locality, primitives, responsibilities, review, rewiring, topology };
}
