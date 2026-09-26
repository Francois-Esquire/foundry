import type { FileKind, ModuleRole } from "./types";

/**
 * V12.3 temporal semantic twin. `semantics history` reconstructs the
 * workspace at selected first-parent commits with the current analyzer and
 * writes compact checkpoint snapshots, a commit timeline, entity lineage,
 * and derived deltas under `.foundry/semantics-history/`. The directory has
 * its own schema and lifecycle: regenerating the current dataset never
 * touches it, and it never touches the current dataset.
 */
export const SEMANTICS_HISTORY_SCHEMA_VERSION = 1;

export type CheckpointStrategy =
  | "monthly"
  | "evenly-spaced"
  | "every-n-commits";

export interface SemanticsHistoryConfig {
  /** Upper bound on selected checkpoints; HEAD always counts as one. */
  checkpoints: number;
  /** Commit stride for `every-n-commits`. */
  every: number;
  /** How far back the timeline reaches: `<n>y`, `<n>m`, `<n>d`, or `all`. */
  range: string;
  strategy: CheckpointStrategy;
}

// ---------------------------------------------------------------------------
// TIMELINE

/** One first-parent commit. File lists carry TypeScript sources only. */
export interface SemanticsHistoryCommit {
  added?: string[];
  additions: number;
  changedFiles: number;
  /** Present when the commit is a selected checkpoint. */
  checkpoint?: true;
  deletions: number;
  hash: string;
  parents: string[];
  removed?: string[];
  /** `[previousPath, path]` pairs Git reported as renames. */
  renamed?: [string, string][];
  /** Committer date, ISO-8601. */
  timestamp: string;
}

export interface SemanticsHistoryTimeline {
  /** Oldest first. */
  commits: SemanticsHistoryCommit[];
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// ENTITIES

export interface TemporalPathSegment {
  path: string;
  /** Commit that introduced this path (an addition or a rename target); absent when the path predates the timeline. */
  since?: string;
  /** Commit that removed or renamed the path away; absent while alive. */
  until?: string;
}

/**
 * One module identity through time. The id is the newest path in the
 * lineage: the current path for modules alive at HEAD, so history ids match
 * the current dataset's module ids.
 */
export interface TemporalModuleLineage {
  id: string;
  segments: TemporalPathSegment[];
}

export interface TemporalPackageLineage {
  /** Checkpoints where the package was discovered, oldest first. */
  checkpoints: string[];
  id: string;
}

export interface SemanticsHistoryEntities {
  modules: TemporalModuleLineage[];
  packages: TemporalPackageLineage[];
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// SNAPSHOTS

export interface TemporalPackageState {
  fanIn?: number;
  fanOut?: number;
  id: string;
  layer?: number;
  moduleCount: number;
  path: string;
  root: string;
}

export type TemporalConceptRole =
  | "declared"
  | "behavior"
  | "implementation"
  | "representation"
  | "usage"
  | "conversion";

export interface TemporalModuleState {
  /** Indices into `snapshot.concepts` per role; roles with no concepts are omitted. */
  concepts?: Partial<Record<TemporalConceptRole, number[]>>;
  fileKind?: FileKind;
  /** Lineage id. */
  id: string;
  layer?: number;
  package: string;
  /** Path at this checkpoint. */
  path: string;
  role?: ModuleRole["kind"];
}

/**
 * `[source, target, scope, typeOnly]`: indices into `snapshot.modules`,
 * scope 0 = intra-package, 1 = cross-package. Indices keep the snapshot a
 * fraction of the size of one written with path ids; the arrays it indexes
 * sit beside it in the same file.
 */
export type TemporalModuleDependency = [number, number, 0 | 1, 0 | 1];

export interface TemporalConceptCenters {
  behavior?: string;
  implementations?: string[];
  representation?: string;
  semantic?: string;
  usage?: string;
}

export interface TemporalConceptState {
  centers: TemporalConceptCenters;
  /** Lineage id: the declaring module's lineage id plus `#name`. */
  id: string;
  kind: string;
  name: string;
  /** Declaring package at this checkpoint. */
  package: string;
  packages: string[];
}

export interface TemporalBoundaryState {
  from: string;
  moduleEdges: number;
  to: string;
}

export interface TemporalCoverage {
  failed: { id: string; error: string }[];
  rootsMissing: string[];
  rootsScanned: string[];
  unitsAnalyzed: number;
  unitsDiscovered: number;
}

export interface TemporalWorkspaceSnapshot {
  boundaries: TemporalBoundaryState[];
  commit: string;
  concepts: TemporalConceptState[];
  coverage: TemporalCoverage;
  dependencies: TemporalModuleDependency[];
  modules: TemporalModuleState[];
  packages: TemporalPackageState[];
  profile: "temporal";
  schemaVersion: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// DELTAS

export interface TemporalConceptRoleChange {
  concept: string;
  from: TemporalConceptRole[];
  module: string;
  to: TemporalConceptRole[];
}

export interface TemporalCenterChange {
  center: "semantic" | "behavior" | "representation" | "usage";
  from?: string;
  id: string;
  to?: string;
}

export interface TemporalSnapshotDelta {
  boundaries: {
    added: string[];
    removed: string[];
    moduleEdges: { id: string; from: number; to: number }[];
  };
  concepts: {
    appeared: string[];
    disappeared: string[];
    span: { id: string; from: string[]; to: string[] }[];
    centers: TemporalCenterChange[];
  };
  dependencies: {
    added: [string, string][];
    removed: [string, string][];
  };
  from: string;
  modules: {
    added: string[];
    removed: string[];
    renamed: { id: string; from: string; to: string }[];
    moved: { id: string; from: string; to: string }[];
    roles: TemporalConceptRoleChange[];
  };
  packages: {
    added: string[];
    removed: string[];
    moduleCount: { id: string; from: number; to: number }[];
  };
  schemaVersion: number;
  to: string;
}

// ---------------------------------------------------------------------------
// MANIFEST

export type SemanticsHistorySnapshotStatus = "complete" | "failed";

export interface SemanticsHistorySnapshotRef {
  bytes?: number;
  /** Reused from the checkpoint cache instead of analyzed. */
  cached: boolean;
  commit: string;
  counts?: {
    packages: number;
    modules: number;
    dependencies: number;
    concepts: number;
    boundaries: number;
  };
  durationMs: number;
  error?: string;
  file?: string;
  status: SemanticsHistorySnapshotStatus;
  timestamp: string;
}

export interface SemanticsHistoryDeltaRef {
  bytes: number;
  file: string;
  from: string;
  to: string;
}

export type SemanticsHistoryPhase =
  | "timeline"
  | "select"
  | "analyze"
  | "lineage"
  | "deltas"
  | "write";

export interface SemanticsHistoryPhaseTiming {
  durationMs: number;
  name: SemanticsHistoryPhase;
}

export interface SemanticsHistoryCheckpointTiming {
  /** Package-local analysis plus the checkpoint's workspace derivation. */
  analyzeMs: number;
  cached: boolean;
  cleanupMs: number;
  commit: string;
  /** Package-local reports served from the content-addressed local cache (V12.6). */
  localsReused?: number;
  projectMs: number;
  workspaceMs: number;
  worktreeMs: number;
}

export interface SemanticsHistoryManifest {
  deltas: SemanticsHistoryDeltaRef[];
  files: {
    manifest: string;
    timeline: string;
    entities: string;
  };
  /** Cache key shared by every checkpoint of this generation. */
  fingerprint: string;
  generatedAt: string;
  generation: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    phases: SemanticsHistoryPhaseTiming[];
    checkpoints: SemanticsHistoryCheckpointTiming[];
    requestedSnapshots: number;
    successfulSnapshots: number;
    failedSnapshots: number;
    cachedSnapshots: number;
    timelineCommits: number;
    concurrency: number;
  };
  policy: {
    historyMode: "first-parent";
    checkpointStrategy: CheckpointStrategy;
    checkpointCount: number;
    every: number;
    renameDetection: string;
    profile: "temporal";
    roots: string[];
    exclude: string[];
  };
  range: {
    /** Configured range expression. */
    requested: string;
    /** Oldest and newest commits on the timeline. */
    from: string;
    to: string;
    fromTimestamp: string;
    toTimestamp: string;
  };
  repository: {
    head: string;
    branch?: string;
  };
  schemaVersion: number;
  snapshots: SemanticsHistorySnapshotRef[];
  versions: {
    packageSchema: number;
    packagePolicy: number;
    workspaceSchema: number;
    workspaceIntelligencePolicy: number;
    historySchema: number;
  };
}

export interface SemanticsHistoryGenerationResult {
  bytes: number;
  files: number;
  manifest: SemanticsHistoryManifest;
  output: string;
}
