import type { DomainDeclaration } from "./domain-declaration";
import type { DatasetManifestLenses } from "./lenses/lens-types";
import type { Rule } from "./rule-declaration";
import type { SemanticsHistoryConfig } from "./semantics-history-types";
import type { FileKind, ModuleRole } from "./types";
import type { WorkspaceConceptCoverage } from "./workspace-concepts-types";

export const DATASET_SCHEMA_VERSION = 5;

export interface SemanticsConfig {
  domains: readonly DomainDeclaration[];
  exclude: string[];
  history: SemanticsHistoryConfig;
  rules: readonly Rule[];
}

export type SemanticsDeclarationSource =
  | "pnpm-workspace.yaml"
  | "package.json#workspaces"
  | "package.json";

export interface SemanticsWorkspaceUnit {
  analyzable: boolean;
  declaredDependencies: SemanticsDeclaredDependencies;
  id: string;
  manifestPath: string;
  path: string;
}

type SemanticsSkipReason =
  | "no package manifest"
  | "excluded"
  | "analysis unsupported"
  | "generated output"
  | "gitignored";

export interface SemanticsSkippedDirectory {
  name?: string;
  path: string;
  reason: SemanticsSkipReason;
}

export interface SemanticsDiscovery {
  declarationSource?: SemanticsDeclarationSource;
  excludeUnmatched: string[];
  packagePatterns: string[];
  packagePatternsUnmatched: string[];
  skipped: SemanticsSkippedDirectory[];
  units: SemanticsWorkspaceUnit[];
  unitsDiscovered: number;
}

export type DeclaredDiscovery = SemanticsDiscovery & {
  declarationSource: SemanticsDeclarationSource;
};

type SemanticsPackageStatus = "complete" | "failed";

export const SEMANTICS_DECLARED_DEPENDENCY_KINDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type SemanticsDeclaredDependencyKind =
  (typeof SEMANTICS_DECLARED_DEPENDENCY_KINDS)[number];

export type SemanticsDeclaredDependencies = Partial<
  Record<SemanticsDeclaredDependencyKind, Record<string, string>>
>;

export interface SemanticsManifestPackage {
  declaredDependencies: SemanticsDeclaredDependencies;
  error?: string;
  id: string;
  internals?: string;
  modules: { count: number; shard?: string };
  path: string;
  projection?: string;
  report?: string;
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
  | "write"
  | "lenses"
  | "visualization";

export type SemanticsGenerationMode = "full" | "incremental";

export interface SemanticsGenerationInputs {
  config: string;
  hash: string;
}

interface SemanticsGenerationMetadata {
  artifactsGenerated: number;
  artifactsReused: number;
  command: string;
  concurrency: number;
  derived: boolean;
  finishedAt: string;
  inputs?: SemanticsGenerationInputs;
  mode: SemanticsGenerationMode;
  packageFailures: number;
  packagesAnalyzed: number;
  packagesReused: number;
  partial: boolean;
  phases: SemanticsPhaseTiming[];
  startedAt: string;
  totalDurationMs: number;
}

export type SemanticsInvalidationReason =
  | "full-rebuild"
  | "sources-changed"
  | "evolution-changed"
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
  fingerprint?: string;
  id: string;
  kind: "package-local" | "package-report" | "workspace-stage";
  reason:
    | {
        type: "direct";
        cause: SemanticsInvalidationReason;
        changed?: string[];
      }
    | { type: "dependency"; source: string[] };
  status: "reuse" | "recompute" | "remove";
}

interface SemanticsManifestFiles {
  conceptIndex: string;
  dependencyInventory?: string;
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
  visualization?: string;
  workspace: string;
}

export interface DatasetManifest {
  counts: {
    packages: number;
    modules: number;
    concepts: number;
    boundaries: number;
    patterns: number;
  };
  coverage: "complete" | "partial";
  discovery: {
    declarationSource: SemanticsDeclarationSource;
    excludeUnmatched: string[];
    packagePatterns: string[];
    packagePatternsUnmatched: string[];
    packagesFound: number;
    unitsAnalyzed: number;
    unitsDiscovered: number;
    unitsSkipped: SemanticsSkippedDirectory[];
  };
  files: SemanticsManifestFiles;
  generatedAt: string;
  generation: SemanticsGenerationMetadata;
  lenses: DatasetManifestLenses;
  packages: SemanticsManifestPackage[];
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
  dependencies: { incoming: string[]; outgoing: string[] };
  evolution?: {
    commits: number;
    linesChanged: number;
    authors: number;
    lastChangedAt?: string;
    hotspot: boolean;
    hotspotSignals: string[];
    couplings: string[];
  };
  fileKind?: FileKind;
  graph?: { fanIn: number; fanOut: number; layer: number; cycle: boolean };
  gravity?: {
    fanIn: number;
    fanOut: number;
    transitiveDependents: number;
    transitiveDependencies: number;
  };
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
  fanIn: number;
  fanOut: number;
  fileKind?: FileKind;
  id: string;
  mapPosition?: { x: number; y: number };
  package: string;
  path: string;
  role?: ModuleRole["kind"];
  shard: string;
}

export interface SemanticsModuleEdge {
  id: string;
  relation: "dependency";
  scope: "intra-package" | "cross-package";
  source: string;
  target: string;
  typeOnly?: boolean;
}

export interface SemanticsModuleEdgeShard {
  edges: SemanticsModuleEdge[];
  package: string;
}

export interface SemanticsModuleIndex {
  coverage: {
    moduleEdges: "sharded";
    note: string;
  };
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
    reused: number;
    removed: number;
  };
  bytes: number;
  cache: {
    dir: string;
    packageEntries: number;
    localEntries: number;
    bytes: number;
    localBytes: number;
  };
  concepts: number;
  coverage: "complete" | "partial";
  dryRun: boolean;
  durationMs: number;
  errors: SemanticsGenerationError[];
  files: number;
  invalidations: SemanticsInvalidation[];
  largest: { file: string; bytes: number }[];
  manifest: string;
  missingPackages: string[];
  mode: SemanticsGenerationMode;
  modules: number;
  output: string;
  packages: {
    discovered: number;
    analyzed: number;
    unchanged: number;
    reused: number;
    complete: number;
    failed: number;
    skipped: number;
  };
  phases: SemanticsPhaseTiming[];
  reports: {
    derived: number;
    unchanged: number;
    reused: number;
  };
}
