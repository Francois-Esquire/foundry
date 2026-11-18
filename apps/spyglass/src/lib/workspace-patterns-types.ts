import type {
  ArchitecturalReviewDisposition,
  ArchitecturalReviewUncertaintyKind,
  RecenteringScenarioKind,
  ScenarioImpactUncertaintyKind,
} from "./types";
import type { WorkspaceGraphCertainty } from "./workspace-graph-types";

type WorkspacePatternEvidenceSource =
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

export interface WorkspacePatternSupport {
  boundaries: string[];
  boundaryCount: number;
  conceptCount: number;
  concepts: string[];
  observations: WorkspacePatternEvidence[];
  packages: string[];
}

export type WorkspacePatternEvidenceStrength =
  | "strong"
  | "moderate"
  | "limited";

export type WorkspacePatternCoverage = "complete" | "partial";

export type WorkspaceArchitecturalRoleKind =
  | "semantic-center"
  | "implementation-center"
  | "representation-center"
  | "conversion-center"
  | "consumption-center"
  | "integration-center";

export interface WorkspaceArchitecturalRole {
  coverage: WorkspacePatternCoverage;
  kind: WorkspaceArchitecturalRoleKind;
  package: string;
  sourcePackages: string[];
  strength: WorkspacePatternEvidenceStrength;
  support: WorkspacePatternSupport;
}

export interface WorkspaceReviewContext {
  credibleAlternatives: string[];
  dispositions: Partial<Record<ArchitecturalReviewDisposition, number>>;
  dominatedBaselines: string[];
  dominatingKinds: Partial<Record<RecenteringScenarioKind, number>>;
  preserved: string[];
  reviewed: number;
}

export interface WorkspacePackageRoleProfile {
  analyzed: boolean;
  counts: {
    declared: number;
    declaredCrossPackage: number;
    directionTargets: number;
    foreignImplemented: number;
    foreignBehaved: number;
    foreignRepresented: number;
    foreignUsed: number;
    foreignConverted: number;
    foreignSources: number;
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

export interface WorkspacePackagePairPattern {
  conceptCount: number;
  conceptRoles: {
    implementation: string[];
    behavior: string[];
    representation: string[];
    usage: string[];
    conversion: string[];
  };
  conversionPairs: string[];
  coverage: WorkspacePatternCoverage;
  evolution: {
    couplings: string[];
    concepts: string[];
    coChangeCommits: number;
  };
  from: string;
  graph: {
    forward: number | null;
    reverse: number | null;
    usageOnly: boolean;
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

type WorkspaceConceptPatternKind =
  | "parallel-contract-implementations"
  | "cross-package-conversion-projection"
  | "shared-semantic-primitive"
  | "cross-layer-contract"
  | "repeated-behavior-externalization";

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

type WorkspaceReviewPatternScope = "package" | "gravity-center" | "direction";

export interface WorkspaceReviewPattern {
  entityIds: string[];
  id: string;
  impactUncertainties: Partial<Record<ScenarioImpactUncertaintyKind, number>>;
  reviews: WorkspaceReviewContext;
  scope: WorkspaceReviewPatternScope;
  unresolvedCauses: Partial<Record<ArchitecturalReviewUncertaintyKind, number>>;
}

type WorkspaceCoveragePatternKind =
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

type WorkspaceArchitectureStatementKind =
  | "semantic-upstream-consumption"
  | "downstream-implementation-convergence"
  | "consumption-concentration"
  | "conversion-concentration"
  | "parallel-implementation-motif"
  | "conversion-projection-motif"
  | "review-tension-concentration";

export interface WorkspaceArchitectureStatement {
  conceptCount: number;
  detail: string;
  kind: WorkspaceArchitectureStatementKind;
  packages: string[];
  patternIds: string[];
}

export interface WorkspacePatternThreshold {
  counts: { below: number; at: number; above: number };
  name: string;
  value: number;
}

interface WorkspacePatternSummary {
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

type WorkspacePatternCautionKind =
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
