import type { AnalysisConfig } from "./config";
import type { FileMapCapabilities } from "./dataset-analysis";
import type {
  PreparedFileMap,
  RepositoryFileMapInput,
} from "./file-map-preparation";
import {
  analyzeFileMapWorkspace,
  prepareFileMap,
} from "./file-map-preparation";
import { analyzePreparedPackageLocal } from "./package-local-analysis";
import type { PackageLocalReport } from "./package-local-types";
import type { WorkspaceSurfaceDerivation } from "./workspace-derive-types";

// INTERNAL fixture-proof entry: prepares a recorded repository file map
// (`file-map-preparation.ts`), runs package-local analysis for every
// workspace package and then the workspace derivation, and returns the
// results with the capabilities and provenance the map allows. It creates no
// Worker and reads no repository file system, Git or network. Callable
// directly on any thread; past preparation's cruise it does not yield. Not a
// repository scan, dataset or public export.

export interface FileMapAnalysisInput extends RepositoryFileMapInput {
  readonly config?: AnalysisConfig;
}

export interface FileMapAnalysis {
  capabilities: FileMapCapabilities;
  derivation: WorkspaceSurfaceDerivation;
  locals: PackageLocalReport[];
  prepared: PreparedFileMap;
  /** Wall-clock milliseconds per phase, from `performance.now()`. */
  timing: Record<string, number>;
}

/** Prepare and analyze a file map in memory. */
export async function analyzeFileMap(
  input: FileMapAnalysisInput
): Promise<FileMapAnalysis> {
  const started = performance.now();
  const prepared = await prepareFileMap(input);
  const timing: Record<string, number> = { ...prepared.timing };
  const mark = performance.now();
  const locals = prepared.locals.map((source) =>
    analyzePreparedPackageLocal(source, input.config)
  );
  timing.localAnalysisMs = performance.now() - mark;
  const derivation = analyzeFileMapWorkspace(
    prepared,
    locals,
    input.config,
    timing
  );
  timing.totalMs = performance.now() - started;
  derivation.timing.totalMs = Math.round(timing.totalMs);
  return {
    capabilities: prepared.capabilities,
    derivation,
    locals,
    prepared,
    timing,
  };
}
