import type { SemanticsHistoryConfig } from "./semantics-history-types";
import type { FileKind, ModuleRole } from "./types";
import type { WorkspaceConceptCoverage } from "./workspace-concepts-types";

/**
 * V12.0 static semantics dataset. One generation materializes every canonical
 * layer (package reports, the V9 workspace, V9.4 projections) plus small
 * indexes and per-module records under `.foundry/semantics/`, so a plain
 * HTTP client can explore the architecture without the analyzer. The
 * directory contract is versioned on its own; the package, workspace, and
 * projection schemas it embeds keep theirs.
 */
export const SEMANTICS_DATASET_SCHEMA_VERSION = 3;

export interface SemanticsConfig {
  /** Repository-relative unit directories to skip (`packages/foo`). */
  exclude: string[];
  /** V12.3 temporal dataset policy; `semantics history` reads it. */
  history: SemanticsHistoryConfig;
  /** Repository-relative dataset directory. */
  output: string;
  /** Repository-relative directories whose children are workspace units. */
  roots: string[];
}

export interface SemanticsWorkspaceUnit {
  analyzable: boolean;
  /** Package name from the manifest. */
  id: string;
  manifestPath: string;
  name: string;
  /** Repository-relative directory, posix. */
  path: string;
  root: string;
}

type SemanticsSkipReason =
  | "no package manifest"
  | "excluded"
  | "analysis unsupported"
  | "generated output"
  | "gitignored";

export interface SemanticsSkippedDirectory {
  path: string;
  reason: SemanticsSkipReason;
}

export interface SemanticsDiscovery {
  directoriesInspected: number;
  /** Configured roots that do not exist. */
  rootsMissing: string[];
  rootsScanned: string[];
  skipped: SemanticsSkippedDirectory[];
  units: SemanticsWorkspaceUnit[];
}

type SemanticsPackageStatus = "complete" | "failed" | "skipped";

export interface SemanticsManifestPackage {
  error?: string;
  id: string;
  modules: { count: number; shard?: string };
  name: string;
  path: string;
  /** V9.4 `WorkspacePackageProjection`; absent when the workspace does not hold the package. */
  projection?: string;
  /** Full `SurfaceReport`; absent when the analysis failed. */
  report?: string;
  root: string;
  status: SemanticsPackageStatus;
}

export interface SemanticsPhaseTiming {
  durationMs: number;
  name: SemanticsPhase;
}

export type SemanticsPhase =
  | "discover"
  | "fingerprint"
  | "analyze"
  | "derive"
  | "ingest"
  | "intelligence"
  | "project"
  | "write";

export type SemanticsGenerationMode = "full" | "incremental";

interface SemanticsGenerationMetadata {
  artifactsGenerated: number;
  artifactsReused: number;
  command: string;
  concurrency: number;
  /** Whether workspace derivation ran, or every assembled report was reused. */
  derived: boolean;
  finishedAt: string;
  /** V12.5 provenance; volatile, never needed to read the dataset. */
  mode: SemanticsGenerationMode;
  packageFailures: number;
  /** Package-local reports analyzed in this build (V12.6). */
  packagesAnalyzed: number;
  /** Package-local reports taken from the cache. */
  packagesReused: number;
  partial: boolean;
  phases: SemanticsPhaseTiming[];
  startedAt: string;
  totalDurationMs: number;
}

/** Why a package analysis was reused, recomputed, or dropped in this build. */
export type SemanticsInvalidationReason =
  | "full-rebuild"
  | "sources-changed"
  | "history-changed"
  | "clock-changed"
  | "config-changed"
  | "analysis-changed"
  | "package-added"
  | "package-removed"
  | "cache-missing"
  | "cache-corrupt"
  | "cache-schema-changed"
  | "fingerprint-unchanged";

export interface SemanticsInvalidation {
  /** Combined input fingerprint of the package under this build. */
  fingerprint?: string;
  /** Package id, or the stage name for workspace-level artifacts. */
  id: string;
  /**
   * `package-local`: the package's own analysis (V12.6), keyed by its own
   * sources. `package-report`: the assembled report, keyed by the whole
   * workspace since its derived half reads every package.
   */
  kind: "package-local" | "package-report" | "workspace-stage";
  reason:
    | {
        type: "direct";
        cause: SemanticsInvalidationReason;
        /** Root-relative inputs that differ from the previous build, when known. */
        changed?: string[];
      }
    | { type: "dependency"; source: string[] };
  status: "reuse" | "recompute" | "remove";
}

interface SemanticsManifestFiles {
  conceptIndex: string;
  couplings: string;
  moduleIndex: string;
  projections: {
    manifest: string;
    overview: string;
    packageRoles: string;
    directions: string;
    boundaries: string;
    dependencyGraph: string;
    implementationFlow: string;
    behaviorFlow: string;
    patterns: string;
  };
  workspace: string;
}

export interface SemanticsManifest {
  counts: {
    packages: number;
    modules: number;
    concepts: number;
    boundaries: number;
    patterns: number;
  };
  /** `partial` when a unit failed or the workspace's own coverage is incomplete. */
  coverage: "complete" | "partial";
  discovery: {
    rootsScanned: string[];
    rootsMissing: string[];
    directoriesInspected: number;
    unitsDiscovered: number;
    unitsAnalyzed: number;
    unitsSkipped: SemanticsSkippedDirectory[];
  };
  files: SemanticsManifestFiles;
  generatedAt: string;
  generation: SemanticsGenerationMetadata;
  packages: SemanticsManifestPackage[];
  roots: string[];
  schemaVersion: number;
  versions: {
    packageSchema: number;
    packagePolicy: number;
    workspaceSchema: number;
    workspaceIntelligencePolicy: number;
    projectionSchema: number;
  };
  workspace: { name?: string; root: string };
}

export interface SemanticsModuleRecord {
  cautions: string[];
  concepts: {
    declared: string[];
    behavior: string[];
    implementation: string[];
    representation: string[];
    usage: string[];
    conversion: string[];
  };
  /** Cross-package module edges only; see the index coverage note. */
  dependencies: { incoming: string[]; outgoing: string[] };
  /** By path convention: source, test, story, config, other. */
  fileKind?: FileKind;
  /** V9.1 facts over the cross-package module graph. */
  graph?: { fanIn: number; fanOut: number; layer: number; cycle: boolean };
  /** V9.0 gravity as the owning package measured it on the workspace module graph. */
  gravity?: {
    fanIn: number;
    fanOut: number;
    transitiveDependents: number;
    transitiveDependencies: number;
  };
  history?: {
    commits: number;
    linesChanged: number;
    authors: number;
    lastChangedAt?: string;
    hotspot: boolean;
    hotspotSignals: string[];
    /** Coupling pair ids this module takes part in. */
    couplings: string[];
  };
  /** Root-relative path; the canonical module id. */
  id: string;
  package: string;
  path: string;
  role?: ModuleRole["kind"];
}

export interface SemanticsModuleShard {
  modules: SemanticsModuleRecord[];
  package: string;
}

export interface SemanticsModuleIndexEntry {
  fileKind?: FileKind;
  id: string;
  package: string;
  path: string;
  role?: ModuleRole["kind"];
  /** Dataset-relative shard holding the full record. */
  shard: string;
}

/**
 * One directed module dependency. Direction is the import direction and is
 * never a semantic direction; the layout may use it symmetrically.
 */
export interface SemanticsModuleEdge {
  /** `${source}→${target}` */
  id: string;
  relation: "dependency";
  scope: "intra-package" | "cross-package";
  source: string;
  target: string;
  /** Absent when the observing report predates per-edge type metadata. */
  typeOnly?: boolean;
}

/** Every edge whose `source` the package owns, sorted by id. */
export interface SemanticsModuleEdgeShard {
  edges: SemanticsModuleEdge[];
  package: string;
}

export interface SemanticsModuleIndex {
  coverage: {
    moduleEdges: "sharded";
    note: string;
  };
  /** Sorted by package; a referenced package has one when it sources cross-package edges. */
  edgeShards: {
    package: string;
    file: string;
    intraPackage: number;
    crossPackage: number;
  }[];
  modules: SemanticsModuleIndexEntry[];
  schemaVersion: number;
  shards: { package: string; file: string; count: number }[];
}

/**
 * One co-change pair as the workspace recorded it. `left`/`right` follow the
 * sorted pair id and carry no direction; the conditionals are per side.
 */
interface SemanticsCouplingPair {
  coChangeCommits: number;
  /** `${left}|${right}` */
  id: string;
  jaccard: number;
  lastCoChangedAt?: string;
  left: string;
  leftCommits: number;
  /** coChangeCommits / leftCommits: how often left's change included right. */
  leftConditional: number;
  leftPackage: string;
  right: string;
  rightCommits: number;
  /** coChangeCommits / rightCommits: how often right's change included left. */
  rightConditional: number;
  rightPackage: string;
  scope: "same-package" | "cross-package";
}

export interface SemanticsCouplingIndex {
  couplings: SemanticsCouplingPair[];
  schemaVersion: number;
}

interface SemanticsConceptIndexEntry {
  centers: {
    semantic?: string;
    representation?: string;
    usage?: string;
    behavior?: string;
  };
  coverage: WorkspaceConceptCoverage;
  file: string;
  id: string;
  kind: string;
  name: string;
  package: string;
  packages: string[];
}

export interface SemanticsConceptIndex {
  concepts: SemanticsConceptIndexEntry[];
  schemaVersion: number;
}

export interface SemanticsGenerationError {
  message: string;
  phase: SemanticsPhase;
  unit?: string;
}

export interface SemanticsGenerationResult {
  artifacts: {
    generated: number;
    /** Byte-identical to the previous dataset; carried over without rewriting. */
    reused: number;
    /** Present in the previous dataset only. */
    removed: number;
  };
  bytes: number;
  cache: {
    dir: string;
    /** Assembled-report entries. */
    packageEntries: number;
    /** Package-local report entries (V12.6). */
    localEntries: number;
    bytes: number;
    localBytes: number;
  };
  concepts: number;
  coverage: "complete" | "partial";
  /** Fingerprints and cache lookups only; nothing analyzed or written. */
  dryRun: boolean;
  durationMs: number;
  errors: SemanticsGenerationError[];
  files: number;
  invalidations: SemanticsInvalidation[];
  largest: { file: string; bytes: number }[];
  manifest: string;
  /** Packages the workspace knows but no unit analyzed, sorted. */
  missingPackages: string[];
  mode: SemanticsGenerationMode;
  modules: number;
  output: string;
  packages: {
    discovered: number;
    /** Package-local reports analyzed in this build. */
    analyzed: number;
    /** Analyzed, and the canonical local report equalled the cached one. */
    unchanged: number;
    /** Package-local report taken from the cache without analysis. */
    reused: number;
    complete: number;
    failed: number;
    skipped: number;
  };
  phases: SemanticsPhaseTiming[];
  /** Assembled reports: workspace derivation output, keyed by the whole workspace. */
  reports: {
    /** Derived and assembled in this build. */
    derived: number;
    /** Derived, and canonically equal to the cached assembled report. */
    unchanged: number;
    /** Taken from the cache; derivation did not run for them. */
    reused: number;
  };
}
