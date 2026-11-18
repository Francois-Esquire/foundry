import type { SemanticsDeclarationSource } from "./semantics-types";
import type { FileKind, ModuleRole } from "./types";

export const HISTORY_SCHEMA_VERSION = 1;

export const SEMANTICS_HISTORY_STRATEGIES = [
  "monthly",
  "evenly-spaced",
  "every-n-commits",
] as const;

type CheckpointStrategy = (typeof SEMANTICS_HISTORY_STRATEGIES)[number];

export interface SemanticsHistoryConfig {
  checkpoints: number;
  every: number;
  range: string;
  strategy: CheckpointStrategy;
}

export interface SemanticsHistoryCommit {
  added?: string[];
  additions: number;
  changedFiles: number;
  checkpoint?: true;
  deletions: number;
  hash: string;
  parents: string[];
  removed?: string[];
  renamed?: [string, string][];
  timestamp: string;
}

export interface SemanticsHistoryTimeline {
  commits: SemanticsHistoryCommit[];
  schemaVersion: number;
}

export interface TemporalPathSegment {
  path: string;
  since?: string;
  until?: string;
}

export interface TemporalModuleLineage {
  id: string;
  segments: TemporalPathSegment[];
}

interface TemporalPackageLineage {
  checkpoints: string[];
  id: string;
}

export interface SemanticsHistoryEntities {
  modules: TemporalModuleLineage[];
  packages: TemporalPackageLineage[];
  schemaVersion: number;
}

export interface TemporalPackageState {
  fanIn?: number;
  fanOut?: number;
  id: string;
  layer?: number;
  moduleCount: number;
  path: string;
}

export type TemporalConceptRole =
  | "declared"
  | "behavior"
  | "implementation"
  | "representation"
  | "usage"
  | "conversion";

export interface TemporalModuleState {
  concepts?: Partial<Record<TemporalConceptRole, number[]>>;
  fileKind?: FileKind;
  id: string;
  layer?: number;
  package: string;
  path: string;
  role?: ModuleRole["kind"];
}

export type TemporalModuleDependency = [number, number, 0 | 1, 0 | 1];

interface TemporalConceptCenters {
  behavior?: string;
  implementations?: string[];
  representation?: string;
  semantic?: string;
  usage?: string;
}

export interface TemporalConceptState {
  centers: TemporalConceptCenters;
  id: string;
  kind: string;
  name: string;
  package: string;
  packages: string[];
}

interface TemporalBoundaryState {
  from: string;
  moduleEdges: number;
  to: string;
}

interface TemporalCoverage {
  declarationSource?: SemanticsDeclarationSource;
  failed: { id: string; error: string }[];
  packagePatterns: string[];
  packagePatternsUnmatched: string[];
  packagesFound: number;
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

type SemanticsHistorySnapshotStatus = "complete" | "failed";

export interface SemanticsHistorySnapshotRef {
  bytes?: number;
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
  analyzeMs: number;
  cached: boolean;
  cleanupMs: number;
  commit: string;
  localsReused?: number;
  projectMs: number;
  workspaceMs: number;
  worktreeMs: number;
}

export interface HistoryManifest {
  deltas: SemanticsHistoryDeltaRef[];
  files: {
    manifest: string;
    timeline: string;
    entities: string;
  };
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
    exclude: string[];
  };
  range: {
    requested: string;
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
  manifest: HistoryManifest;
  output: string;
}
