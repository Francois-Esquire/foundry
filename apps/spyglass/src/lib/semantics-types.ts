import type { DomainDeclaration } from "./domain-declaration";
import type { DatasetManifestLenses } from "./lenses/lens-types";
import type { Rule } from "./rule-declaration";
import type { SemanticsHistoryConfig } from "./semantics-history-types";
import type { FileKind, ModuleRole } from "./types";
import type { WorkspaceConceptCoverage } from "./workspace-concepts-types";

/**
 * The dataset's schema version, the promise a reader holds the dataset to:
 * every file the manifest names, in the shape this version gives it. A scan
 * saves it in the manifest, and a reader refuses any other. The package,
 * workspace, and projection schemas the dataset embeds keep their own
 * versions.
 */
export const DATASET_SCHEMA_VERSION = 5;

/**
 * The resolved configuration a scan runs under: what the workspace's
 * configuration files declare, over the defaults. Which directories are
 * packages is not configuration; the workspace declaration decides it, or
 * the root package is analyzed on its own without one.
 */
export interface SemanticsConfig {
  /** The workspace's domains, as declared. No analysis reads them, and the configuration fingerprint leaves them out. */
  domains: readonly DomainDeclaration[];
  /** Workspace-relative unit directories to skip (`packages/foo`), matched exactly. */
  exclude: string[];
  /** The checkpoint policy of `scan --history`. */
  history: SemanticsHistoryConfig;
  /** The workspace's rules, as declared. No analysis reads them, and the configuration fingerprint leaves them out. */
  rules: readonly Rule[];
}

/** Where the workspace declaration came from. */
export type SemanticsDeclarationSource =
  | "pnpm-workspace.yaml"
  | "package.json#workspaces"
  | "package.json";

export interface SemanticsWorkspaceUnit {
  analyzable: boolean;
  declaredDependencies: SemanticsDeclaredDependencies;
  /** Package name from the manifest. */
  id: string;
  manifestPath: string;
  /** Workspace-relative directory, posix. */
  path: string;
}

type SemanticsSkipReason =
  | "no package manifest"
  | "excluded"
  | "analysis unsupported"
  | "generated output"
  | "gitignored";

export interface SemanticsSkippedDirectory {
  /** The name its `package.json` gives, when it has one that parses; absent otherwise. */
  name?: string;
  path: string;
  reason: SemanticsSkipReason;
}

export interface SemanticsDiscovery {
  /** Absent when neither a workspace declaration nor a standalone package is found. */
  declarationSource?: SemanticsDeclarationSource;
  /** Excluded directories that no package pattern matched, so a typo shows. */
  excludeUnmatched: string[];
  /** The package patterns, as the workspace declaration lists them. */
  packagePatterns: string[];
  /** Package patterns, normalized and without negations, that matched no directory. */
  packagePatternsUnmatched: string[];
  skipped: SemanticsSkippedDirectory[];
  /** The units that are packages: a named manifest and TypeScript sources. */
  units: SemanticsWorkspaceUnit[];
  /** Every directory a package pattern matched, once each. */
  unitsDiscovered: number;
}

/** A discovery with a workspace declaration or standalone package, as a scan requires. */
export type DeclaredDiscovery = SemanticsDiscovery & {
  declarationSource: SemanticsDeclarationSource;
};

type SemanticsPackageStatus = "complete" | "failed";

/** The `package.json` fields that declare dependencies, in the order the dataset's manifest lists them. */
export const SEMANTICS_DECLARED_DEPENDENCY_KINDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type SemanticsDeclaredDependencyKind =
  (typeof SEMANTICS_DECLARED_DEPENDENCY_KINDS)[number];

/** Each kind a package's `package.json` declares, every name with its range as written. */
export type SemanticsDeclaredDependencies = Partial<
  Record<SemanticsDeclaredDependencyKind, Record<string, string>>
>;

export interface SemanticsManifestPackage {
  declaredDependencies: SemanticsDeclaredDependencies;
  error?: string;
  id: string;
  /** `PackageInternals`; absent when the scan left internals out or the package failed. */
  internals?: string;
  modules: { count: number; shard?: string };
  path: string;
  /** V9.4 `WorkspacePackageProjection`; absent when the workspace does not hold the package. */
  projection?: string;
  /** Full `SurfaceReport`; absent when the analysis failed. */
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
  | "lenses";

export type SemanticsGenerationMode = "full" | "incremental";

/**
 * The workspace inputs a dataset was generated from: `hash`, one combined
 * hash of every input an analysis reads (the sources, Git's commits and
 * tracked files, the UTC day, the exclusions and profile, the analysis
 * version), and `config`, the exclusions-and-profile part alone, so a
 * reader that runs no configuration can still recompute `hash`.
 */
export interface SemanticsGenerationInputs {
  config: string;
  hash: string;
}

interface SemanticsGenerationMetadata {
  artifactsGenerated: number;
  artifactsReused: number;
  command: string;
  concurrency: number;
  /** Whether workspace derivation ran, or every assembled report was reused. */
  derived: boolean;
  finishedAt: string;
  /** The inputs it was generated from (3.6); absent in a dataset saved before. */
  inputs?: SemanticsGenerationInputs;
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

export interface DatasetManifest {
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
    declarationSource: SemanticsDeclarationSource;
    excludeUnmatched: string[];
    packagePatterns: string[];
    packagePatternsUnmatched: string[];
    /** Units that are packages: a named manifest and TypeScript sources. */
    packagesFound: number;
    unitsAnalyzed: number;
    /** Every directory a package pattern matched. */
    unitsDiscovered: number;
    unitsSkipped: SemanticsSkippedDirectory[];
  };
  files: SemanticsManifestFiles;
  generatedAt: string;
  generation: SemanticsGenerationMetadata;
  /** Every lens's output, by id; the reader gives a dataset saved before lenses existed an empty map. */
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
  /** Cross-package module edges only; see the index coverage note. */
  dependencies: { incoming: string[]; outgoing: string[] };
  /** What the Git log says of the module; absent without Git. */
  evolution?: {
    commits: number;
    linesChanged: number;
    authors: number;
    lastChangedAt?: string;
    hotspot: boolean;
    hotspotSignals: string[];
    /** Ids of the co-change pairs this module takes part in, which resolve in `workspace.json#evolution.couplings`. */
    couplings: string[];
  };
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
  /**
   * The module's import edges in and out, within and across packages,
   * counted from the edge shards as they are written, so that a reader of
   * the index has every module's counts without reading a shard. Equal to
   * the record's `gravity.fanIn` and `fanOut` wherever gravity was
   * observed. Since schema version 5.
   */
  fanIn: number;
  fanOut: number;
  fileKind?: FileKind;
  id: string;
  /** Original map placement, computed at scan time so opening the viewer reads no edge shards. */
  mapPosition?: { x: number; y: number };
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
