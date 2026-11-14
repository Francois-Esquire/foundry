import { basename } from "#path";
import {
  ANALYSIS_POLICY_VERSION,
  WORKSPACE_INTELLIGENCE_POLICY_VERSION,
} from "./config";
import { DATASET_FILES } from "./dataset-layout";
import { lensEntries } from "./lenses/lens-types";
import type {
  DatasetManifest,
  DeclaredDiscovery,
  SemanticsConceptIndex,
  SemanticsGenerationInputs,
  SemanticsGenerationMode,
  SemanticsManifestPackage,
  SemanticsModuleRecord,
  SemanticsPhaseTiming,
} from "./semantics-types";
import { DATASET_SCHEMA_VERSION } from "./semantics-types";
import type { SurfaceReport } from "./types";
import type { WorkspaceProjectionContext } from "./workspace-projection-types";
import { WORKSPACE_PROJECTION_SCHEMA_VERSION } from "./workspace-projection-types";
import { WORKSPACE_SCHEMA_VERSION } from "./workspace-types";

const SURFACE_REPORT_SCHEMA_VERSION: SurfaceReport["schemaVersion"] = 35;

export interface DatasetManifestInput {
  command: string;
  concepts: SemanticsConceptIndex;
  concurrency: number;
  context: WorkspaceProjectionContext;

  derived: boolean;
  discovery: DeclaredDiscovery;

  files: readonly { reused: boolean }[];
  finishedAt: Date;

  inputs?: SemanticsGenerationInputs;
  mode: SemanticsGenerationMode;
  modules: readonly SemanticsModuleRecord[];
  packages: SemanticsManifestPackage[];

  packagesAnalyzed: number;

  packagesReused: number;
  partial: boolean;
  phases: SemanticsPhaseTiming[];
  root: string;
  startedAt: Date;
  workspaceName: string | undefined;
}

export function datasetManifest(input: DatasetManifestInput): DatasetManifest {
  const { context, discovery, files, finishedAt, packages, startedAt } = input;
  const { workspace } = context;
  const failures = packages.filter((p) => p.status === "failed").length;
  const artifactsReused = files.filter((f) => f.reused).length;
  return {
    counts: {
      boundaries: workspace.boundaries.boundaries.length,
      concepts: input.concepts.concepts.length,
      modules: input.modules.length,
      packages: workspace.packages.packages.length,
      patterns: context.index.patterns.length,
    },
    coverage: input.partial ? "partial" : "complete",
    discovery: {
      declarationSource: discovery.declarationSource,
      excludeUnmatched: discovery.excludeUnmatched,
      packagePatterns: discovery.packagePatterns,
      packagePatternsUnmatched: discovery.packagePatternsUnmatched,
      packagesFound: discovery.units.length,
      unitsAnalyzed: packages.length - failures,
      unitsDiscovered: discovery.unitsDiscovered,
      unitsSkipped: discovery.skipped,
    },
    files: DATASET_FILES,
    generatedAt: finishedAt.toISOString(),
    generation: {
      artifactsGenerated: files.length - artifactsReused,
      artifactsReused,
      command: input.command,
      concurrency: input.concurrency,
      derived: input.derived,
      finishedAt: finishedAt.toISOString(),
      ...(input.inputs !== undefined && { inputs: input.inputs }),
      mode: input.mode,
      packageFailures: failures,
      packagesAnalyzed: input.packagesAnalyzed,
      packagesReused: input.packagesReused,
      partial: input.partial,
      phases: input.phases,
      startedAt: startedAt.toISOString(),
      totalDurationMs: finishedAt.getTime() - startedAt.getTime(),
    },
    lenses: lensEntries(),
    packages,
    schemaVersion: DATASET_SCHEMA_VERSION,
    versions: {
      packagePolicy: ANALYSIS_POLICY_VERSION,
      packageSchema: SURFACE_REPORT_SCHEMA_VERSION,
      projectionSchema: WORKSPACE_PROJECTION_SCHEMA_VERSION,
      workspaceIntelligencePolicy: WORKSPACE_INTELLIGENCE_POLICY_VERSION,
      workspaceSchema: WORKSPACE_SCHEMA_VERSION,
    },
    workspace: {
      ...(input.workspaceName !== undefined && { name: input.workspaceName }),
      root: basename(input.root),
    },
  };
}
