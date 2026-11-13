import { assembleSurfaceReport } from "./assemble";
import type {
  DatasetAnalysisOrigin,
  FileMapCapabilities,
  GitHubRepositoryAnalysisOrigin,
} from "./dataset-analysis";
import type { DatasetAssemblyOutcome } from "./dataset-assembly";
import { requireDeclared } from "./discovery-rules";
import type { FileMapAnalysisInput } from "./file-map-analysis";
import { prepareFileMap } from "./file-map-preparation";
import type { InMemoryDataset } from "./in-memory-dataset";
import { assembleInMemoryDataset } from "./in-memory-dataset";
import type { LensSettings } from "./lenses/lens-types";
import { analyzePreparedPackageLocal } from "./package-local-analysis";
import type { PackageLocalReport } from "./package-local-types";
import type { SemanticsPhase } from "./semantics-types";
import { analyzePreparedWorkspace } from "./workspace-analysis";

// INTERNAL composition: a recorded repository file map to an in-memory
// dataset read through the existing `datasetReader`. It prepares the map
// (native discovery's rules and the dependency inventory over the map),
// analyzes each package, derives the workspace, assembles each unit's
// report as the native derive stage does, and runs the scan's shared
// artifact assembly into a collection this result owns. No repository file
// system, Git, network, Worker or server is involved, and no repository
// code runs; the cruise reads the map from the isolated engine's private
// in-memory volume (`file-map-cruise.ts`). Not a public export.
//
// The call is asynchronous and cooperative on the caller's own thread: it
// yields one macrotask between steps (after preparation, after each
// package, after derivation and before each assembly phase), checks the
// signal before and after every yield, and reports each step's start and
// end. The steps themselves are synchronous compiler and analysis calls and
// cannot be interrupted: an abort is observed at the next boundary, so the
// longest wait is the longest step, normally preparation (the program and
// its module graph) or one package's analysis. On abort the call rejects
// with the signal's reason and keeps nothing: the project, prepared inputs,
// reports and artifacts are referenced only by this call.
//
// What a native scan has and this does not, each explicit on the result
// and saved with the dataset (`reader().analysis()`): no inputs fingerprint
// (`provenance.inputsFingerprint: "unrecorded"`), no internals
// (`provenance.internals: "not-assembled"`; the reader raises its existing
// error), no Git history (the reports carry `not-git-repository`) and only
// the map's supplied declarations for types (`capabilities.types`). The
// module graph is the native cruise over the map (`capabilities.moduleGraph`).
// A unit whose local analysis throws fails the whole call instead of
// publishing a partial dataset.

export interface FileMapDatasetInput extends FileMapAnalysisInput {
  /** Recorded as the manifest's generation command. Default: `fileMapDataset`. */
  readonly command?: string;
  /**
   * Where a loader obtained the map, saved as the dataset's origin instead
   * of a plain file map. The map's
   * `root` must be the one the repository and scope give.
   */
  readonly repository?: Pick<
    GitHubRepositoryAnalysisOrigin,
    "acquisition" | "repository"
  >;
  /**
   * The workspace's declared domains and rules, as data: configuration
   * modules are never run. Default: none, as for a workspace that declares
   * nothing.
   */
  readonly settings?: LensSettings;
}

/** One step of a file-map scan, reported when it starts and when it ends. */
export type FileMapDatasetProgress =
  | { phase: "prepare"; stage: "start" | "end" }
  | {
      phase: "analyze";
      /** Zero-based, in discovery order. */
      index: number;
      /** The unit's repository-relative directory. */
      package: string;
      stage: "start" | "end";
      total: number;
    }
  | { phase: "derive"; stage: "start" | "end" }
  | { phase: "assemble"; stage: "start"; step: SemanticsPhase };

export interface FileMapDatasetOptions {
  /**
   * The wall clock read once before preparation, for the manifest's
   * `startedAt`, and at assembly's end, for `finishedAt`. Default:
   * `new Date()`.
   */
  readonly clock?: () => Date;
  /** Called synchronously at each step boundary. */
  readonly onProgress?: (progress: FileMapDatasetProgress) => void;
  /** Checked before and after every yield; an abort rejects with its reason. */
  readonly signal?: AbortSignal;
  /** Yields to the event loop between steps. Default: one `setTimeout(0)` macrotask. */
  readonly yieldTask?: () => Promise<void>;
}

export interface FileMapDataset extends InMemoryDataset<FileMapCapabilities> {
  /**
   * Wall-clock milliseconds of the preparation phases, the analysis steps
   * (`localAnalysisMs`, `workspaceAnalysisMs`, their sum with preparation
   * in `totalMs`), `assemblyMs`, and `scanMs` for the whole call, yields
   * included.
   */
  timing: Record<string, number>;
}

/** The message a native scan records when derivation gives a unit no report. */
const NO_DERIVED_REPORT = "Derivation produced no report.";

/** One macrotask, so rendering, input and other tasks can run in between. */
const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** The saved origin: the loaded repository when there is one, else the file map. */
function originOf(
  input: FileMapDatasetInput,
  command: string
): DatasetAnalysisOrigin {
  return input.repository === undefined
    ? { command, kind: "file-map", root: input.root }
    : {
        acquisition: input.repository.acquisition,
        command,
        kind: "github-repository",
        repository: input.repository.repository,
        root: input.root,
      };
}

/** A phase every `prepareFileMap` call records. */
function phaseMs(timing: Record<string, number>, phase: string): number {
  const ms = timing[phase];
  if (ms === undefined) {
    throw new Error(`The file-map preparation recorded no ${phase}.`);
  }
  return ms;
}

/**
 * Builds a complete in-memory dataset from a recorded file map. Rejects
 * with `FileMapInputError` for an unacceptable map, the native discovery
 * error for a map with no workspace declaration or standalone package, and
 * the signal's reason once the signal aborts.
 */
export async function fileMapDataset(
  input: FileMapDatasetInput,
  options: FileMapDatasetOptions = {}
): Promise<FileMapDataset> {
  const { onProgress, signal } = options;
  const clock = options.clock ?? (() => new Date());
  const yieldTask = options.yieldTask ?? macrotask;
  /** Boundary between steps: check, yield, check again. */
  const boundary = async (): Promise<void> => {
    signal?.throwIfAborted();
    await yieldTask();
    signal?.throwIfAborted();
  };

  signal?.throwIfAborted();
  const startedAt = clock();
  const scanStarted = performance.now();

  onProgress?.({ phase: "prepare", stage: "start" });
  const prepared = await prepareFileMap(input);
  const timing: Record<string, number> = { ...prepared.timing };
  onProgress?.({ phase: "prepare", stage: "end" });
  const discovery = requireDeclared(input.root, prepared.discovery);
  const { inventory } = prepared;
  if (inventory === undefined) {
    throw new Error("A declared file map was prepared without its inventory.");
  }
  await boundary();

  const total = prepared.locals.length;
  const locals: PackageLocalReport[] = [];
  timing.localAnalysisMs = 0;
  for (const [index, source] of prepared.locals.entries()) {
    const unit = prepared.targets[index] ?? "";
    onProgress?.({
      index,
      package: unit,
      phase: "analyze",
      stage: "start",
      total,
    });
    const at = performance.now();
    locals.push(analyzePreparedPackageLocal(source, input.config));
    timing.localAnalysisMs += performance.now() - at;
    onProgress?.({
      index,
      package: unit,
      phase: "analyze",
      stage: "end",
      total,
    });
    await boundary();
  }

  onProgress?.({ phase: "derive", stage: "start" });
  let at = performance.now();
  const derivation = analyzePreparedWorkspace(
    locals,
    prepared.prepared,
    input.config
  );
  timing.workspaceAnalysisMs = performance.now() - at;
  onProgress?.({ phase: "derive", stage: "end" });
  timing.totalMs = Object.entries(timing)
    .filter(([phase]) => phase !== "totalMs")
    .reduce((sum, [, ms]) => sum + ms, 0);
  derivation.timing.totalMs = Math.round(timing.totalMs);

  const outcomes = discovery.units.map((unit, index) => {
    const local = locals[index];
    if (local === undefined || local.package.path !== unit.path) {
      throw new Error(`No local report aligned with unit ${unit.path}.`);
    }
    const derived = derivation.packages[local.package.path];
    return derived === undefined
      ? { error: NO_DERIVED_REPORT, local, unit }
      : { local, report: assembleSurfaceReport(local, derived), unit };
  }) satisfies DatasetAssemblyOutcome[];
  const discoverMs =
    phaseMs(timing, "validateAndMapMs") + phaseMs(timing, "discoveryMs");
  const deriveMs = timing.workspaceAnalysisMs;
  const command = input.command ?? "fileMapDataset";
  at = performance.now();
  const dataset = await assembleInMemoryDataset({
    beforePhase: async (step) => {
      await boundary();
      onProgress?.({ phase: "assemble", stage: "start", step });
    },
    capabilities: prepared.capabilities,
    command,
    discovery,
    inventory,
    now: clock,
    origin: originOf(input, command),
    outcomes,
    phases: [
      { durationMs: Math.round(discoverMs), name: "discover" },
      {
        durationMs: Math.round(timing.totalMs - discoverMs - deriveMs),
        name: "analyze",
      },
      { durationMs: Math.round(deriveMs), name: "derive" },
    ],
    root: input.root,
    settings: input.settings ?? { domains: [], rules: [] },
    startedAt,
    workspaceName: prepared.workspaceName,
  });
  signal?.throwIfAborted();
  timing.assemblyMs = performance.now() - at;
  timing.scanMs = performance.now() - scanStarted;
  return { ...dataset, timing };
}
