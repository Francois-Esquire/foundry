import { assembleSurfaceReport } from "./assemble";
import type { AnalysisConfig } from "./config";
import type {
  DatasetAnalysisOrigin,
  FileMapCapabilities,
  GitHubRepositoryAnalysisOrigin,
} from "./dataset-analysis";
import type { DatasetAssemblyOutcome } from "./dataset-assembly";
import { requireDeclared } from "./discovery-rules";
import type { RepositoryFileMapInput } from "./file-map-preparation";
import {
  analyzeFileMapWorkspace,
  prepareFileMap,
} from "./file-map-preparation";
import type { InMemoryDataset } from "./in-memory-dataset";
import { assembleInMemoryDataset } from "./in-memory-dataset";
import type { LensSettings } from "./lenses/lens-types";
import { analyzePreparedPackageLocal } from "./package-local-analysis";
import type { PackageLocalReport } from "./package-local-types";
import type { SemanticsPhase } from "./semantics-types";

export interface FileMapDatasetInput extends RepositoryFileMapInput {
  readonly command?: string;
  readonly config?: AnalysisConfig;

  readonly repository?: Pick<
    GitHubRepositoryAnalysisOrigin,
    "acquisition" | "repository"
  >;

  readonly settings?: LensSettings;
}

export type FileMapDatasetProgress =
  | { phase: "prepare"; stage: "start" | "end" }
  | {
      phase: "analyze";

      index: number;

      package: string;
      stage: "start" | "end";
      total: number;
    }
  | { phase: "derive"; stage: "start" | "end" }
  | { phase: "assemble"; stage: "start"; step: SemanticsPhase };

export interface FileMapDatasetOptions {
  readonly clock?: () => Date;

  readonly onProgress?: (progress: FileMapDatasetProgress) => void;

  readonly signal?: AbortSignal;

  readonly yieldTask?: () => Promise<void>;
}

export interface FileMapDataset extends InMemoryDataset<FileMapCapabilities> {
  timing: Record<string, number>;
}

const NO_DERIVED_REPORT = "Derivation produced no report.";

const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

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

function phaseMs(timing: Record<string, number>, phase: string): number {
  const ms = timing[phase];
  if (ms === undefined) {
    throw new Error(`The file-map run recorded no ${phase}.`);
  }
  return ms;
}

export async function fileMapDataset(
  input: FileMapDatasetInput,
  options: FileMapDatasetOptions = {}
): Promise<FileMapDataset> {
  const { onProgress, signal } = options;
  const clock = options.clock ?? (() => new Date());
  const yieldTask = options.yieldTask ?? macrotask;

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
  const derivation = analyzeFileMapWorkspace(
    prepared,
    locals,
    input.config,
    timing
  );
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
  const deriveMs = phaseMs(timing, "workspaceAnalysisMs");
  const command = input.command ?? "fileMapDataset";
  const at = performance.now();
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
