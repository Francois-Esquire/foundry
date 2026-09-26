import type {
  ArchitecturalReviewDisposition,
  ArchitecturalReviewUncertaintyKind,
  RecenteringScenarioKind,
  ScenarioImpactUncertaintyKind,
} from "./types";
import type { WorkspaceGraphCertainty } from "./workspace-graph-types";

/**
 * V9.3 workspace architectural patterns: recurrence across V9.2 concept
 * placements, V9.1 topology, V9.0 history, and V8 reviews, synthesized
 * into descriptive repository-wide roles and motifs. Every pattern carries
 * its support and evidence; none carries a score, a quality reading, or a
 * recommendation. A single concept observation is never a pattern.
 */

export type WorkspacePatternEvidenceSource =
  | "workspace-graph"
  | "workspace-concepts"
  | "boundary"
  | "evolution"
  | "v8-review"
  | "anchor"
  | "package-profile";

export interface WorkspacePatternEvidence {
  entities: string[];
  kind: string;
  source: WorkspacePatternEvidenceSource;
  value?: number | string | boolean;
}

/** What a pattern rests on; always listed, never summarized into a number alone. */
export interface WorkspacePatternSupport {
  boundaries: string[];
  boundaryCount: number;
  conceptCount: number;
  concepts: string[];
  observations: WorkspacePatternEvidence[];
  packages: string[];
}

/**
 * Evidence completeness, not probability. `strong`: support at or above
 * `strongMultiplier × minimum`, evidence from at least two sources, and
 * every supporting package analyzed. `moderate`: support at the minimum
 * with two sources, or twice the minimum from one; partial coverage caps
 * a pattern here. `limited`: the minimum from one source.
 */
export type WorkspacePatternEvidenceStrength =
  | "strong"
  | "moderate"
  | "limited";

/** `complete` when every package the pattern names was analyzed; otherwise counts are lower bounds. */
export type WorkspacePatternCoverage = "complete" | "partial";

export type WorkspaceArchitecturalRoleKind =
  | "semantic-center"
  | "implementation-center"
  | "representation-center"
  | "conversion-center"
  | "consumption-center"
  | "integration-center";

/**
 * One descriptive role a package plays for concepts declared elsewhere (or,
 * for `semantic-center`, for its own concepts consumed elsewhere). Several
 * roles per package are normal; no package is forced into one.
 */
export interface WorkspaceArchitecturalRole {
  coverage: WorkspacePatternCoverage;
  kind: WorkspaceArchitecturalRoleKind;
  package: string;
  /** Declaring packages of the supporting concepts (the package itself for `semantic-center` targets). */
  sourcePackages: string[];
  strength: WorkspacePatternEvidenceStrength;
  support: WorkspacePatternSupport;
}

/** Disposition counts over reviewed concepts in one scope; ids are concept ids. */
export interface WorkspaceReviewContext {
  credibleAlternatives: string[];
  dispositions: Partial<Record<ArchitecturalReviewDisposition, number>>;
  /** Concepts whose preserve-current baseline is dominated. */
  dominatedBaselines: string[];
  /** Scenario kinds that dominate baselines, counted. */
  dominatingKinds: Partial<Record<RecenteringScenarioKind, number>>;
  /** Concepts reviewed `preserve-current` or `multiple-tradeoffs`. */
  preserved: string[];
  reviewed: number;
}

export interface WorkspacePackageRoleProfile {
  analyzed: boolean;
  /** Raw counts behind the roles, so a package without a role still reads. */
  counts: {
    declared: number;
    /** Declared here and present in at least one other package. */
    declaredCrossPackage: number;
    /** Distinct packages receiving a semantic direction from here. */
    directionTargets: number;
    /** Concepts declared elsewhere, by this package's role in them. */
    foreignImplemented: number;
    foreignBehaved: number;
    foreignRepresented: number;
    foreignUsed: number;
    foreignConverted: number;
    /** Distinct declaring packages of foreign concepts held in any role. */
    foreignSources: number;
    /** Cross-package conversion pairs whose converter lives here. */
    conversionsOwned: number;
  };
  graph?: {
    layer: number;
    fanIn: number;
    fanOut: number;
    dependencyReachShare: number;
    dependentReachShare: number;
    articulation: boolean;
    role: string;
  };
  package: string;
  /** V6 architectural profile signals; context only. */
  profileSignals: string[];
  reviews?: WorkspaceReviewContext;
  roles: WorkspaceArchitecturalRole[];
}

export type WorkspaceDirectionPattern =
  | "stable-responsibility-split"
  | "repeated-externalization"
  | "repeated-consumption"
  | "representation-projection"
  | "implementation-channel"
  | "mixed";

/**
 * Ordered package pair in semantic direction: `from` declares the concepts,
 * `to` holds a role in them. `graph` is the static direction, kept apart:
 * `forward` is `from` reaching `to`, `reverse` the opposite.
 */
export interface WorkspacePackagePairPattern {
  conceptCount: number;
  conceptRoles: {
    implementation: string[];
    behavior: string[];
    representation: string[];
    usage: string[];
    conversion: string[];
  };
  /** Cross-package conversion pair ids joining the two packages. */
  conversionPairs: string[];
  coverage: WorkspacePatternCoverage;
  evolution: {
    /** Source-source member couplings crossing the pair. */
    couplings: string[];
    concepts: string[];
    coChangeCommits: number;
  };
  from: string;
  graph: {
    forward: number | null;
    reverse: number | null;
    usageOnly: boolean;
    /** Package edge joining the pair in either direction, when one exists. */
    directEdge: string | null;
    fromLayer: number | null;
    toLayer: number | null;
  };
  id: string;
  patterns: WorkspaceDirectionPattern[];
  reviews?: WorkspaceReviewContext;
  strength: WorkspacePatternEvidenceStrength;
  support: WorkspacePatternSupport;
  to: string;
}

export type WorkspaceBoundaryPatternKind =
  | "high-volume-channel"
  | "high-concept-diversity"
  | "implementation-channel"
  | "representation-channel"
  | "consumption-channel"
  | "structural-seam"
  | "historically-reinforced";

/** One package edge with its concept load, graph structure, and history read together. */
export interface WorkspaceBoundaryPattern {
  boundaryId: string;
  conceptLoad: number;
  coverage: WorkspacePatternCoverage;
  evolution: { couplings: string[]; concepts: string[] };
  from: string;
  graph: {
    importSites: number | null;
    moduleEdges: number;
    severedPairs: number;
    alternativeRoutes: number;
    weakBridge: boolean;
    seam: boolean;
    fromLayer: number | null;
    toLayer: number | null;
  };
  kinds: WorkspaceBoundaryPatternKind[];
  roleLoad: {
    semanticUse: number;
    behavior: number;
    implementation: number;
    representation: number;
    conversion: number;
  };
  strength: WorkspacePatternEvidenceStrength;
  support: WorkspacePatternSupport;
  to: string;
}

export type WorkspaceConceptPatternKind =
  | "parallel-contract-implementations"
  | "cross-package-conversion-projection"
  | "shared-semantic-primitive"
  | "cross-layer-contract"
  | "repeated-behavior-externalization";

/**
 * A structure several concepts share. `structure` names the packages that
 * define the recurrence (never the concept names): for parallel
 * implementations the external implementation packages, for projections
 * the two packages and their converters, for primitives and cross-layer
 * contracts the declaring package, for externalization the competing
 * gravity center.
 */
export interface WorkspaceConceptPattern {
  concepts: string[];
  coverage: WorkspacePatternCoverage;
  id: string;
  kind: WorkspaceConceptPatternKind;
  packages: string[];
  reviews?: WorkspaceReviewContext;
  strength: WorkspacePatternEvidenceStrength;
  structure: Record<string, string | string[] | number | boolean>;
  support: WorkspacePatternSupport;
}

export type WorkspaceEvolutionaryPatternKind =
  | "repeated-cross-boundary-change"
  | "implementation-cochange"
  | "representation-cochange"
  | "static-temporal-alignment"
  | "static-temporal-tension";

/** Source-source concept member couplings crossing one unordered package pair. */
export interface WorkspaceEvolutionaryPattern {
  boundaries: string[];
  coChangeCommits: number;
  concepts: string[];
  couplings: string[];
  coverage: WorkspacePatternCoverage;
  id: string;
  kinds: WorkspaceEvolutionaryPatternKind[];
  packages: string[];
  strength: WorkspacePatternEvidenceStrength;
  support: WorkspacePatternSupport;
}

/**
 * V8 dispositions aggregated by scope. `package`: the declaring package.
 * `gravity-center`: the finding's strongest observed center other than the
 * declaring package. `direction`: declaring package → gravity center.
 */
export type WorkspaceReviewPatternScope =
  | "package"
  | "gravity-center"
  | "direction";

export interface WorkspaceReviewPattern {
  entityIds: string[];
  id: string;
  /** V8.3 impact uncertainty kinds behind partially simulated scenarios. */
  impactUncertainties: Partial<Record<ScenarioImpactUncertaintyKind, number>>;
  reviews: WorkspaceReviewContext;
  scope: WorkspaceReviewPatternScope;
  /** Unresolved uncertainty kinds over the scope's reviews. */
  unresolvedCauses: Partial<Record<ArchitecturalReviewUncertaintyKind, number>>;
}

/** Analyzer blind spots; diagnostics, never architecture. */
export type WorkspaceCoveragePatternKind =
  | "structural-conformance-gap"
  | "partial-package-coverage"
  | "cross-package-module-graph-gap"
  | "composition-root-gap"
  | "unmeasured-edge";

export interface WorkspaceCoveragePattern {
  concepts: string[];
  count: number;
  detail: string;
  entities: string[];
  kind: WorkspaceCoveragePatternKind;
}

export type WorkspaceArchitectureStatementKind =
  | "semantic-upstream-consumption"
  | "downstream-implementation-convergence"
  | "consumption-concentration"
  | "conversion-concentration"
  | "parallel-implementation-motif"
  | "conversion-projection-motif"
  | "review-tension-concentration";

/** A factual sentence built from patterns; `patternIds` are its trace. */
export interface WorkspaceArchitectureStatement {
  conceptCount: number;
  detail: string;
  kind: WorkspaceArchitectureStatementKind;
  packages: string[];
  patternIds: string[];
}

/** Candidate counts one step below, at, and one step above a support threshold. */
export interface WorkspacePatternThreshold {
  counts: { below: number; at: number; above: number };
  name: string;
  value: number;
}

export interface WorkspacePatternSummary {
  boundaryPatterns: number;
  conceptPatterns: number;
  coveragePatterns: number;
  evolutionaryPatterns: number;
  limited: number;
  moderate: number;
  packagePairPatterns: number;
  packageRoles: number;
  packagesWithRoles: number;
  reviewPatterns: number;
  strong: number;
}

export type WorkspacePatternCautionKind =
  | "partial-coverage"
  | "lower-bound-support"
  | "sparse-review-coverage"
  | "no-wiring-evidence";

export interface WorkspacePatternCaution {
  detail: string;
  entities: string[];
  kind: WorkspacePatternCautionKind;
}

export interface WorkspaceArchitecturalPatterns {
  boundaries: WorkspaceBoundaryPattern[];
  cautions: WorkspacePatternCaution[];
  certainty: WorkspaceGraphCertainty;
  conceptPatterns: WorkspaceConceptPattern[];
  coveragePatterns: WorkspaceCoveragePattern[];
  evolutionaryPatterns: WorkspaceEvolutionaryPattern[];
  packagePairs: WorkspacePackagePairPattern[];
  packages: WorkspacePackageRoleProfile[];
  reviewPatterns: WorkspaceReviewPattern[];
  statements: WorkspaceArchitectureStatement[];
  summary: WorkspacePatternSummary;
  thresholds: WorkspacePatternThreshold[];
}
