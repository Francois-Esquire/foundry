import type { AnalysisConfig } from "./config";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "namespace"
  | "other";

export type UsageContext =
  | "type-reference"
  | "parameter-type"
  | "return-type"
  | "property-type"
  | "implements"
  | "extends"
  | "call"
  | "construct"
  | "value-reference"
  | "re-export"
  | "unknown";

export type UsageNamespace = "type" | "value" | "both" | "none";

export type SymbolAccess = "public" | "deep" | "both" | "unused";

export interface ConsumerUsage {
  boundary: string;
  importSites: number;
  references: number;
  usageContexts: Partial<Record<UsageContext, number>>;
  usageNamespace: UsageNamespace;
}

export interface ConsumerModuleUsage {
  importSites: number;
  module: string;
  package: string;
  references: number;
}

export interface SurfaceSymbol {
  access: SymbolAccess;
  consumerModules: string[];
  consumerModuleUsage: ConsumerModuleUsage[];
  consumerPackages: string[];
  consumers: ConsumerUsage[];
  declarationFile: string;
  exported: boolean;
  externalImportSites: number;
  externalReferences: number;
  id: string;
  kind: SymbolKind;
  name: string;
  packagePublic: boolean;
  primaryConsumerShare: number;
  usageContexts: Partial<Record<UsageContext, number>>;
  usageNamespace: UsageNamespace;
}

interface SurfaceSummary {
  declaredSurfaceRatio: number;
  exportUtilization: number;
  externallyUsedSymbols: number;
  externalSurfaceRatio: number;
  moduleExportedSymbols: number;
  moduleOnlyExports: number;
  packagePublicSymbols: number;
  totalSymbols: number;
  unusedExternalExports: number;
}

export type PackageShapeSignal =
  | "single-consumer"
  | "concentrated-consumption"
  | "distributed-consumption"
  | "high-fan-in"
  | "high-fan-out"
  | "one-way-satellite"
  | "shared-hub";

export interface ModuleDependencyEdge {
  fromFile: string;
  toFile: string;
  typeOnly?: boolean;
}

export interface SymbolDependencyUsage {
  importSites: number;
  references: number;
  symbolId: string;
  symbolName: string;
  usageContexts: Partial<Record<UsageContext, number>>;
  usageNamespace: UsageNamespace;
}

export interface PackageConsumer {
  importSites: number;
  moduleEdges: ModuleDependencyEdge[];
  package: string;
  referenceShare: number;
  references: number;
  surfaceShare: number;
  symbols: SymbolDependencyUsage[];
  symbolsUsed: number;
  usageNamespace: UsageNamespace;
}

export interface PackageDependency {
  moduleEdges: number;
  modules: ModuleDependencyEdge[];
  package: string;
}

export interface SurfaceDependencies {
  averageSymbolDistribution: number;
  consumerPackages: number;
  dependencyPackages: number;
  incoming: PackageConsumer[];
  outgoing: PackageDependency[];
  primaryConsumer?: {
    package: string;
    referenceShare: number;
    surfaceShare: number;
  };
  shapeSignals: PackageShapeSignal[];
}

export type ReductionOperation =
  | "internalize-symbol"
  | "fold-package"
  | "preserve-shared-boundary";

export interface ReductionEvidence {
  metric: string;
  significance: "supporting" | "strong";
  value: string | number | boolean;
}

interface ReductionCaution {
  detail: string;
  reason: string;
}

interface ReductionSubject {
  id: string;
  name: string;
  type: "symbol" | "package";
}

interface EstimatedReduction {
  metric: string;
  value: number;
}

export interface ReductionOpportunity {
  cautions: ReductionCaution[];
  estimatedReduction: EstimatedReduction[];
  evidence: ReductionEvidence[];
  evidenceConfidence: number;
  id: string;
  operation: ReductionOperation;
  subject: ReductionSubject;
  summary: string;
  target?: {
    type: "package";
    id: string;
    name: string;
  };
}

export interface FailedGate {
  actual: string | number | boolean;
  expected: string | number | boolean;
  gate: string;
}

export interface IneligibleOperation {
  failedGates: FailedGate[];
  operation: ReductionOperation;
}

export type PlanStatus = "ready" | "blocked" | "unsupported";

type PublicRouteKind =
  | "named-export"
  | "named-reexport"
  | "type-export"
  | "subpath-export"
  | "star-export"
  | "other";

export interface PublicExposureRoute {
  chain: string[];
  entrypoint: string;
  exportedName: string;
  file: string;
  kind: PublicRouteKind;
  line?: number;
  statement?: string;
}

export interface PlannedChange {
  description: string;
  file: string;
  kind:
    | "remove-public-export"
    | "rewrite-public-export"
    | "move-file"
    | "rewrite-import"
    | "internalize-surface"
    | "remove-package-dependency"
    | "remove-package-boundary"
    | "update-project-reference"
    | "review-config"
    | "unsupported";
}

export interface PlanBlocker {
  detail: string;
  reason: string;
}

export interface StructuralDelta {
  exportedSymbols?: number;
  externallyUsedSymbols?: number;
  filesMoved?: number;
  importSitesRewritten?: number;
  packageBoundaries?: number;
  packageDependencyEdges?: number;
  totalSymbols?: number;
  unusedExternalExports?: number;
}

export interface InternalizeSymbolPlan {
  blockers: PlanBlocker[];
  evidence: ReductionEvidence[];
  fingerprint: string;
  id: string;
  intelligence?: PlanIntelligence;
  operation: "internalize-symbol";
  plannedChanges: PlannedChange[];
  predictedDelta: StructuralDelta;
  preservedBehavior: string[];
  publicRoutes: PublicExposureRoute[];
  status: PlanStatus;
  subject: ReductionSubject;
  target: { package: string; path: string };
}

export interface FoldFile {
  file: string;
  kind: "source" | "test" | "config" | "other";
}

export interface FoldDestination {
  directory?: string;
  package: string;
  path?: string;
  resolution: "resolved" | "suggested" | "unresolved";
}

export interface PackageMetadataImpact {
  detail: string;
  file: string;
  kind:
    | "source-manifest"
    | "source-tsconfig"
    | "consumer-dependency"
    | "project-reference"
    | "workspace-entry";
}

interface FoldBoundaryUsage {
  consumedSymbols: number;
  importSites: number;
  moduleEdges: number;
  usageNamespace: UsageNamespace;
}

export interface FoldPackagePlan {
  blockers: PlanBlocker[];
  boundaryUsage: FoldBoundaryUsage;
  cautions: ReductionCaution[];
  consumedSurface: SymbolDependencyUsage[];
  dependencyEdges: ModuleDependencyEdge[];
  destination: FoldDestination;
  evidence: ReductionEvidence[];
  externalConsumers: string[];
  files: FoldFile[];
  fingerprint: string;
  id: string;
  intelligence?: PlanIntelligence;
  operation: "fold-package";
  packageMetadata: PackageMetadataImpact[];
  plannedChanges: PlannedChange[];
  potentiallyInternalized: string[];
  predictedDelta: { certain: StructuralDelta; potential: StructuralDelta };
  source: { package: string; path: string };
  status: PlanStatus;
}

export type ReductionPlan = InternalizeSymbolPlan | FoldPackagePlan;

export interface PlanScale {
  files: {
    total: number;
    source: number;
    test: number;
    config: number;
    other: number;
  };
  imports: {
    sites: number;
    moduleEdges: number;
  };
  symbols: {
    total: number;
    moduleExported: number;
    packagePublic: number;
    externallyUsed: number;
  };
}

interface PlanRouteBurden {
  supported: number;
  total: number;
  unsupported: number;
}

export interface PlanSurface {
  consumedSurfaceRatio: number | null;
  externallyUsedSymbols: number;
  moduleExportedSymbols: number;
  moduleOnlyExports: number;
  packagePublicSymbols: number;
  potentiallyInternalizedSymbols: number;
  publicRoutes?: PlanRouteBurden;
  referenceDensity?: number | null;
  unusedExternalExports: number;
  unusedExternalSurfaceRatio: number | null;
}

interface PlanBoundaryFlow {
  cycle: boolean;
  destinationToSource: boolean;
  sourceToDestination: boolean;
}

export interface PlanBoundary {
  consumerPackages: number;
  dependencyPackages: number;
  flow?: PlanBoundaryFlow;
  importSitesCrossingBoundary: number;
  incomingDependencyEdges: number;
  moduleEdgesCrossingBoundary: number;
  outgoingDependencyEdges: number;
  packageBoundariesAffected: number;
}

export interface PlanIntent {
  anchored: boolean;
  anchors: { target: string; reason?: string }[];
  designedExports: boolean;
  publishable: boolean;
}

interface PlanConsequence {
  certain: StructuralDelta;
  potential: StructuralDelta;
}

export interface PlanIntelligence {
  boundary: PlanBoundary;
  consequence: PlanConsequence;
  intent: PlanIntent;
  scale: PlanScale;
  surface: PlanSurface;
}

type ValidationStatus = PlanStatus | "stale";

export interface PlanPrecondition {
  actual: string | number | boolean;
  expected: string | number | boolean;
  fact: string;
  holds: boolean;
}

export interface PlanValidation {
  blockers: PlanBlocker[];
  currentFingerprint?: string;
  fingerprint: string;
  preconditions: PlanPrecondition[];
  status: ValidationStatus;
}

export interface OperatorCapabilities {
  apply: boolean;
  plan: boolean;
  validate: boolean;
  verify: boolean;
}

export interface OperatorSummary {
  capabilities: OperatorCapabilities;
  id: string;
  opportunities: number;
  plans: { ready: number; blocked: number; unsupported: number };
  unsupportedReasons: Record<string, number>;
}

export interface VerificationCheck {
  check: string;
  detail: string;
  status: "pass" | "fail";
}

export interface VerificationResult {
  checks: VerificationCheck[];
  observedDelta: StructuralDelta;
  predictedDelta: StructuralDelta;
  status: "pass" | "fail";
}

export interface MutationEdit {
  after: string | null;
  before: string;
  file: string;
}

export interface MutationResult {
  blockers?: PlanBlocker[];
  changedFiles: string[];
  edits?: MutationEdit[];
  observedDelta?: StructuralDelta;
  operator: string;
  plan: ReductionPlan;
  predictedDelta: StructuralDelta;
  status:
    | "preview"
    | "applied"
    | "blocked"
    | "stale"
    | "unsupported"
    | "rolled-back";
  verification?: VerificationResult;
}

export type FunctionKind =
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "arrow"
  | "function-expression";

interface FunctionDecisions {
  cases: number;
  catches: number;
  controlFlow: number;
  defaults: number;
  elseIfs: number;
  expression: number;
  ifs: number;
  logical: number;
  loops: number;
  switches: number;
  ternaries: number;
  total: number;
}

interface FunctionParameters {
  boolean: number;
  defaulted: number;
  optional: number;
  rest: number;
  total: number;
}

interface FunctionExits {
  breaks: number;
  continues: number;
  returns: number;
  throws: number;
}

interface FunctionLoops {
  doWhile: number;
  for: number;
  forIn: number;
  forOf: number;
  total: number;
  while: number;
}

interface FunctionCallbacks {
  maxDepth: number;
  nestedFunctions: number;
}

interface FunctionAsyncShape {
  async: boolean;
  awaits: number;
  generator: boolean;
  yields: number;
}

interface FunctionExceptions {
  catches: number;
  finals: number;
  tries: number;
}

export interface LocalComplexityMetrics {
  async: FunctionAsyncShape;
  callbacks: FunctionCallbacks;
  decisions: FunctionDecisions;
  exceptions: FunctionExceptions;
  exits: FunctionExits;
  loops: FunctionLoops;
  nesting: { max: number };
  parameters: FunctionParameters;
  statements: number;
}

export interface FunctionComplexity {
  exported: boolean;
  file: string;
  id: string;
  kind: FunctionKind;
  line: number;
  metrics: LocalComplexityMetrics;
  name: string;
  ownerSymbolId?: string;
  packagePublic: boolean;
}

export interface MetricDistribution {
  max: number;
  p50: number;
  p90: number;
  p95: number;
}

export interface MetricAggregate {
  average: number;
  distribution: MetricDistribution;
  total: number;
}

export interface LocalComplexitySummary {
  controlFlowDecisions: MetricAggregate;
  decisions: MetricAggregate;
  functionsAnalyzed: number;
  nesting: MetricAggregate;
  parameters: MetricAggregate;
  statements: MetricAggregate;
}

export interface LocalComplexityReport {
  functions: FunctionComplexity[];
  summary: LocalComplexitySummary;
}

export interface WorkspaceModuleGraph {
  edges: ModuleDependencyEdge[];
  modules: string[];
  owners: Record<string, string>;
}

interface GravityNode {
  id: string;
  kind: "package" | "module";
}

export interface ModuleRole {
  entrypoint: boolean;
  kind: "aggregator" | "internal";
  ownDeclarations: number;
  reExports: number;
}

export interface DependencyGravity {
  cycle: {
    member: boolean;
    size: number;
  };
  depth: {
    downstream: number;
    upstream: number;
  };
  direct: {
    fanIn: number;
    fanOut: number;
  };
  fileKind?: FileKind;
  node: GravityNode;
  reach: {
    dependents: number;
    dependencies: number;
  };
  role?: ModuleRole;
  transitive: {
    dependents: number;
    dependencies: number;
  };
}

export interface ModuleEdgeConcentration {
  edges: number;
  module: string;
  share: number;
}

export interface DependencyGravityReport {
  incomingConcentration: ModuleEdgeConcentration[];
  internalEdges: ModuleDependencyEdge[];
  modules: DependencyGravity[];
  outgoingConcentration: ModuleEdgeConcentration[];
  population: {
    packages: number;
    modules: number;
  };
  target: DependencyGravity;
}

export type ArchitecturalProfileSignal =
  | "foundation-like"
  | "integration-like"
  | "shared-hub-like"
  | "leaf-like"
  | "surface-heavy"
  | "narrowly-consumed"
  | "broadly-consumed";

export interface ArchitecturalProfileEvidence {
  metric: string;
  value: number | string | boolean;
}

export interface ArchitecturalProfileSignalResult {
  evidence: ArchitecturalProfileEvidence[];
  signal: ArchitecturalProfileSignal;
}

export interface ArchitecturalGravityProfile {
  cycleMember: boolean;
  dependencyReach: number;
  dependentReach: number;
  downstreamDepth: number;
  fanIn: number;
  fanOut: number;
  transitiveDependencies: number;
  transitiveDependents: number;
  upstreamDepth: number;
}

export interface ArchitecturalSurfaceProfile {
  averageSymbolDistribution: number;
  consumerPackages: number;
  declaredSurfaceRatio: number;
  exportUtilization: number;
  externallyUsedSymbols: number;
  externalSurfaceRatio: number;
  moduleOnlyExports: number;
  packagePublicSymbols: number;
  primaryConsumerShare?: number;
  totalSymbols: number;
  unusedExternalExports: number;
}

export interface ArchitecturalComplexityProfile {
  controlFlowDecisions: MetricDistribution;
  decisions: MetricDistribution;
  functionsAnalyzed: number;
  nesting: MetricDistribution;
  parameters: { p90: number; max: number };
  statements: { p90: number; max: number };
}

export interface ArchitecturalIntentProfile {
  anchored: boolean;
  anchorReason?: string;
  designedExports?: boolean;
  publishable?: boolean;
}

interface ArchitecturalProfile {
  complexity: ArchitecturalComplexityProfile;
  gravity: ArchitecturalGravityProfile;
  intent: ArchitecturalIntentProfile;
  node: GravityNode;
  signals: ArchitecturalProfileSignalResult[];
  surface: ArchitecturalSurfaceProfile;
}

export interface ArchitecturalProfileReport {
  modules?: ArchitecturalProfile[];
  target: ArchitecturalProfile;
}

export interface BoundaryModuleContribution {
  importSites: number;
  module: string;
  moduleEdges: number;
  references: number | null;
  share: number;
  symbols: number;
}

export interface BoundaryInteraction {
  breadth: { sourceModules: number; destinationModules: number };
  concentration: { sourceModuleShare: number; destinationModuleShare: number };
  destinationModules: BoundaryModuleContribution[];
  from: string;
  importSites: number;
  moduleEdges: number;
  sourceModules: BoundaryModuleContribution[];
  surfaceCoverage: number | null;
  symbols: {
    distinct: number;
    packagePublic: number | null;
    references: number | null;
    referencesPerSymbol: number | null;
  };
  to: string;
  usage: {
    namespace: UsageNamespace;
    typeOnlySymbols: number;
    valueOnlySymbols: number;
    bothSymbols: number;
  };
}

export interface BoundaryInteractionTotals {
  importSites: number;
  moduleEdges: number;
  packages: number;
  references: number | null;
  symbols: number;
}

interface BoundaryInteractionSummary {
  incoming: BoundaryInteractionTotals;
  outgoing: BoundaryInteractionTotals;
  throughPaths: number;
}

export interface BoundaryInteractionReport {
  incoming: BoundaryInteraction[];
  outgoing: BoundaryInteraction[];
  summary: BoundaryInteractionSummary;
  target: string;
}

export type PressureDimension =
  | "surface"
  | "consumption"
  | "gravity"
  | "complexity"
  | "boundary";

export interface PressureEvidence {
  dimension: PressureDimension;
  metric: string;
  value: number | string | boolean;
}

export type StructuralPressureKind =
  | "surface-pressure"
  | "integration-pressure"
  | "centralization-pressure"
  | "internal-structure-pressure";

export interface StructuralPressureSignal {
  dimensions: PressureDimension[];
  evidence: PressureEvidence[];
  id: string;
  intent: ArchitecturalIntentProfile;
  kind: StructuralPressureKind;
  scope: { type: "package"; id: string };
}

export interface BoundaryPressureSignal {
  evidence: PressureEvidence[];
  from: string;
  shape: "broad" | "concentrated" | "mixed";
  to: string;
}

export interface StructuralPressureReport {
  boundaries: BoundaryPressureSignal[];
  signals: StructuralPressureSignal[];
  target: string;
}

export type FileKind = "source" | "test" | "story" | "config" | "other";

export type ChurnFileKind = FileKind;

export type CommitComposition = "source-dominant" | "config-dominant" | "mixed";

interface OversizedPolicy {
  configSweepMinPackages: number;
  maxCodeFilesPerCommit: number;
}

export interface FileChurn {
  additions: number;
  authors: number;
  commits: number;
  daysSinceLastChange?: number;
  deletions: number;
  file: string;
  firstChangedAt?: string;
  kind: ChurnFileKind;
  lastChangedAt?: string;
  linesChanged: number;
  ownership?: {
    primaryAuthor: string;
    primaryAuthorShare: number;
  };
  rank: {
    commitPercentile: number;
    lineChurnPercentile: number;
  };
}

interface ChurnNode {
  additions: number;
  authors: number;
  commits: number;
  daysSinceLastChange?: number;
  deletions: number;
  id: string;
  kind: "package" | "module";
  lastChangedAt?: string;
  linesChanged: number;
}

export interface ChurnKindTotals {
  commits: number;
  files: number;
  linesChanged: number;
}

export interface ChurnDistributions {
  authorsPerFile: MetricDistribution;
  commitsPerFile: MetricDistribution;
  daysSinceLastChange: MetricDistribution;
  linesChangedPerFile: MetricDistribution;
}

export interface ChurnSummary {
  additions: number;
  authors: number;
  byKind: Record<ChurnFileKind, ChurnKindTotals>;
  commits: number;
  deletedFiles: number;
  deletions: number;
  filesAnalyzed: number;
  lastChangedAt?: string;
  linesChanged: number;
}

export interface ChurnHistoryInfo {
  analyzedAt: string;
  commitsAnalyzed: number;
  historyComplete: boolean;
  newestCommit?: string;
  oldestCommit?: string;
  since?: string;
  windowDays: number | null;
}

interface ChurnPopulation {
  commits: number;
  distributions: ChurnDistributions;
  filesAnalyzed: number;
}

export type ChurnReport =
  | {
      available: true;
      history: ChurnHistoryInfo;
      target: ChurnNode;
      summary: ChurnSummary;
      distributions: ChurnDistributions;
      files: FileChurn[];
      repository: ChurnPopulation;
    }
  | {
      available: false;
      reason: "git-unavailable" | "not-git-repository" | "not-collected";
    };

export type HotspotSignal =
  | "frequent-change"
  | "branch-heavy"
  | "deep-control-flow"
  | "complexity-dense"
  | "architecturally-central";

interface HotspotEvolution {
  additions: number;
  commitPercentile: number;
  commits: number;
  daysSinceLastChange?: number;
  deletions: number;
  lastChangedAt?: string;
  lineChurnPercentile: number;
  linesChanged: number;
}

export interface HotspotComplexity {
  controlFlowDecisions: { total: number; max: number };
  expressionDecisions: { total: number; max: number };
  functions: number;
  nesting: { max: number };
  statements: { total: number; max: number };
}

export interface HotspotArchitecture {
  moduleGravity?: {
    fanIn: number;
    fanOut: number;
    transitiveDependents: number;
    transitiveDependencies: number;
  };
  package?: string;
}

export interface FileHotspot {
  architecture?: HotspotArchitecture;
  complexity: HotspotComplexity;
  evolution: HotspotEvolution;
  file: string;
  kind: ChurnFileKind;
  rank: {
    commitPercentile: number;
    lineChurnPercentile: number;
    complexityPercentile: number;
  };
  signals: HotspotSignal[];
}

interface HotspotSummary {
  eligibleSourceFiles: number;
  filesAboveCommitP90: number;
  filesAboveCommitP95: number;
  hotspotShare: number;
  hotspots: number;
}

export type HotspotReport =
  | {
      available: true;
      target: string;
      windowDays: number | null;
      summary: HotspotSummary;
      files: FileHotspot[];
    }
  | {
      available: false;
      reason: "git-unavailable" | "not-git-repository" | "not-collected";
    };

export type StaticRelation =
  | "left-to-right"
  | "right-to-left"
  | "bidirectional"
  | "none"
  | "unmeasured";

export interface ChangeCouplingPair {
  coChangeCommits: number;
  jaccard: number;
  lastCoChangedAt?: string;
  left: string;
  leftCommits: number;
  leftConditional: number;
  right: string;
  rightCommits: number;
  rightConditional: number;
  staticPath: StaticPathRelation;
  staticRelation: StaticRelation;
}

export type StaticPathRelation = "direct" | "indirect" | "none" | "unmeasured";

export type CouplingContext =
  | "source-source"
  | "source-test"
  | "test-test"
  | "config-config"
  | "story-related"
  | "mixed";

export interface FileChangeCouplingPair extends ChangeCouplingPair {
  context: CouplingContext;
  leftPackage: string;
  rightPackage: string;
  scope: "same-package" | "cross-package";
}

export type PackageChangeCoupling = ChangeCouplingPair;

export interface FileCouplingSummary {
  file: string;
  partners: number;
  strongest: {
    file: string;
    conditional: number;
    jaccard: number;
  };
}

interface ChangeCouplingHistory {
  commitsConsidered: number;
  commitsExcluded: number;
  observedFilePairs: number;
  oversized: OversizedPolicy;
  windowDays: number | null;
}

interface ChangeCouplingSummary {
  crossPackagePairs: number;
  filePairs: number;
  filePairsWithoutStaticEdge: number;
  filePairsWithoutStaticPath: number;
  packagePairs: number;
  packagePairsWithoutStaticEdge: number;
  samePackagePairs: number;
}

export type ChangeCouplingReport =
  | {
      available: true;
      target: string;
      history: ChangeCouplingHistory;
      summary: ChangeCouplingSummary;
      filePairs: FileChangeCouplingPair[];
      packagePairs: PackageChangeCoupling[];
      files: FileCouplingSummary[];
    }
  | {
      available: false;
      reason: "git-unavailable" | "not-git-repository" | "not-collected";
    };

export interface CommitRadius {
  additions: number | null;
  composition: CommitComposition;
  deletions: number | null;
  files: number;
  filesByKind: Record<ChurnFileKind, number>;
  hash: string;
  linesChanged: number | null;
  packageBoundariesCrossed: number;
  packageSet: string[];
  packages: number;
  sourceFiles: number;
  targetFileShare: number;
  targetFiles: number;
  targetPackages: number;
  timestamp: string;
}

export interface PackageCombination {
  commits: number;
  packages: string[];
}

interface ChangeRadiusHistory {
  commitsEligible: number;
  commitsExcluded: number;
  commitsObserved: number;
  oversized: OversizedPolicy;
  windowDays: number | null;
}

interface ChangeRadiusSummary {
  boundaries: MetricDistribution;
  boundaryCrossingCommits: number;
  boundaryCrossingRate: number;
  commits: number;
  crossPackageCommits: number;
  crossPackageRate: number;
  files: MetricDistribution;
  packageCombinations: PackageCombination[];
  packages: MetricDistribution;
  singlePackageCommits: number;
  sourceFiles: MetricDistribution;
}

export type ChangeRadiusReport =
  | {
      available: true;
      target: string;
      history: ChangeRadiusHistory;
      summary: ChangeRadiusSummary;
      commits: CommitRadius[];
    }
  | {
      available: false;
      reason: "git-unavailable" | "not-git-repository" | "not-collected";
    };

type EvolutionaryDimension = "churn" | "hotspot" | "coupling" | "radius";

export interface EvolutionaryEvidence {
  dimension: EvolutionaryDimension;
  metric: string;
  subject?: string;
  value: number | string | boolean;
}

interface EvolutionarySupport {
  eligibleRadiusCommits: number;
  fileCouplingPairs: number;
  hotspots: number;
  packageCouplingPairs: number;
}

export type EvolutionaryPressureKind =
  | "reinforced-integration-pressure"
  | "reinforced-surface-pressure"
  | "reinforced-centralization-pressure"
  | "reinforced-internal-structure-pressure";

export interface EvolutionaryPressureSignal {
  evolutionaryEvidence: EvolutionaryEvidence[];
  intent: ArchitecturalIntentProfile;
  kind: EvolutionaryPressureKind;
  staticEvidence: PressureEvidence[];
  staticSignal: StructuralPressureKind;
  support: { commits: number };
}

export interface StaticPressureSupport {
  evolutionaryEvidence: EvolutionaryEvidence[];
  staticSignal: StructuralPressureKind;
  status: "static-only" | "insufficient-history";
}

export type ArchitecturalTensionKind =
  | "static-leaf-temporal-coupling"
  | "static-pressure-low-evolution"
  | "temporal-coupling-without-static-path";

export interface ArchitecturalTension {
  evidence: {
    static: PressureEvidence[];
    evolutionary: EvolutionaryEvidence[];
  };
  kind: ArchitecturalTensionKind;
  summary: string;
  support: { commits: number };
}

export interface HotStructuralHub {
  commitPercentile: number;
  commits: number;
  fanIn: number;
  fanOut: number;
  file: string;
  functions: number;
  role?: ModuleRole["kind"];
}

interface EvolutionarySpread {
  boundaryCrossingRate: number;
  crossPackageRate: number;
  edgeLessSpreadCommits: number;
  edgeLessSpreadRate: number;
}

export type EvolutionaryPressureReport =
  | {
      available: true;
      target: string;
      support: EvolutionarySupport;
      historicalSupport: "adequate" | "insufficient";
      spread: EvolutionarySpread;
      reinforced: EvolutionaryPressureSignal[];
      staticOnly: StaticPressureSupport[];
      tensions: ArchitecturalTension[];
      hotStructuralHubs: HotStructuralHub[];
    }
  | {
      available: false;
      reason: "git-unavailable" | "not-git-repository" | "not-collected";
    };

export type ConceptSeedKind =
  | "interface"
  | "class"
  | "type"
  | "enum"
  | "namespace";

export type ConceptRelationshipKind =
  | "implements"
  | "extends"
  | "alias"
  | "type-reference"
  | "parameter-type"
  | "return-type"
  | "property-type"
  | "constructs";

export type ConceptRepresentationRelationship =
  | "implementation"
  | "extension"
  | "alias"
  | "type-user"
  | "factory"
  | "other";

export interface ConceptSeed {
  declaration: { file: string; package: string };
  id: string;
  kind: ConceptSeedKind;
  name: string;
  surface: {
    moduleExported: boolean;
    packagePublic: boolean;
    externallyUsed: boolean;
  };
}

export interface ConceptEvidence {
  file: string;
  kind: "declaration" | ConceptRelationshipKind;
  line: number;
  package: string;
  source?: { symbolId: string; name: string; kind: SymbolKind };
  target: string;
}

export interface ConceptRepresentation {
  file: string;
  kind: SymbolKind;
  name: string;
  occurrences: number;
  package: string;
  relationship: ConceptRepresentationRelationship;
  symbolId: string;
}

export interface ConceptDistribution {
  moduleCount: number;
  modules: string[];
  packageCount: number;
  packagePublicRepresentations: number;
  packages: string[];
  references: number;
}

export interface ConceptFamily {
  distribution: ConceptDistribution;
  distributionAnalysis?: ConceptDistributionAnalysis;
  evidence: ConceptEvidence[];
  relationships: Record<ConceptRelationshipKind, number>;
  representations: ConceptRepresentation[];
  seed: ConceptSeed;
}

interface ConceptInventorySummary {
  aliases: number;
  crossPackageFamilies: number;
  distributedFamilies: number;
  families: number;
  implementations: number;
  seeds: number;
}

export interface ConceptInventoryReport {
  distribution?: ConceptDistributionSummary;
  families: ConceptFamily[];
  summary: ConceptInventorySummary;
  target: string;
}

export type ConceptRepresentationKind =
  | "seed"
  | ConceptRepresentationRelationship;

export interface RepresentationDistribution {
  implementationModules: number;
  implementationPackages: number;
  moduleCount: number;
  packageCount: number;
  packages: {
    package: string;
    representations: number;
    kinds: ConceptRepresentationKind[];
  }[];
  primaryPackage?: string;
  primaryShare: number | null;
  total: number;
}

export interface ReferenceDistribution {
  byModule: {
    module: string;
    package: string;
    references: number;
    share: number;
  }[];
  byPackage: {
    package: string;
    references: number;
    share: number;
    modules: number;
  }[];
  packageCount: number;
  primaryPackage?: string;
  primaryShare: number | null;
  total: number;
}

export interface RelationshipDistribution {
  byKind: {
    relationship: ConceptRelationshipKind;
    total: number;
    packages: { package: string; count: number }[];
  }[];
}

export interface BoundaryDistribution {
  moduleCount: number;
  packageSpan: number;
  referencePackages: string[];
  representationPackages: string[];
  seedPackage: string;
}

export interface ConceptPackagePresence {
  implementations: number;
  package: string;
  references: number;
  relationshipKinds: ConceptRelationshipKind[];
  representations: number;
  seed: boolean;
}

export type ConceptDistributionShape =
  | "local"
  | "cross-package"
  | "implementation-split"
  | "reference-distributed"
  | "representation-concentrated";

export interface TemporalMemberCoupling {
  coChangeCommits: number;
  context: CouplingContext;
  jaccard: number;
  left: { file: string; representations: string[] };
  leftConditional: number;
  right: { file: string; representations: string[] };
  rightConditional: number;
  staticPath: StaticPathRelation;
}

export interface TemporalConceptContext {
  hotspotRepresentations: string[];
  representedFilesWithChurn: number;
  strongMemberCouplings: TemporalMemberCoupling[];
}

export interface ConceptDistributionAnalysis {
  boundaries: BoundaryDistribution;
  packages: ConceptPackagePresence[];
  references: ReferenceDistribution;
  relationships: RelationshipDistribution;
  representations: RepresentationDistribution;
  seed: { id: string; name: string; kind: ConceptSeedKind; package: string };
  shapes: ConceptDistributionShape[];
  temporal?: TemporalConceptContext;
}

interface ConceptDistributionSummary {
  crossPackage: number;
  families: number;
  implementationSplit: number;
  local: number;
  referenceDistributed: number;
  representationConcentrated: number;
  temporallyCoupled: number;
}

export interface ConceptDistributionReport {
  families: ConceptDistributionAnalysis[];
  summary: ConceptDistributionSummary;
  target: string;
}

export type ConceptOverlapDimension =
  | "name"
  | "structure"
  | "usage"
  | "conversion"
  | "distribution"
  | "temporal";

type ConceptOverlapEvidenceKind =
  | "name-token-overlap"
  | "property-overlap"
  | "assignability"
  | "conversion"
  | "shared-consumer"
  | "distribution-overlap"
  | "temporal-coupling";

export interface ConceptOverlapEvidence {
  dimension: ConceptOverlapDimension;
  kind: ConceptOverlapEvidenceKind;
  value: number | string | boolean | string[];
}

export interface ConceptIdentity {
  file: string;
  id: string;
  inTarget: boolean;
  kind: ConceptSeedKind;
  name: string;
  package: string;
}

interface ConceptShapeProperty {
  callable: boolean;
  name: string;
  optional: boolean;
  readonly: boolean;
  typeFingerprint: string;
}

export interface ConceptShape {
  properties: ConceptShapeProperty[];
}

export interface ConceptNameAffinity {
  jaccard: number;
  sharedTokens: string[];
}

export interface ConceptPropertyOverlap {
  baseShared: string[];
  compatibleShared: string[];
  jaccard: number;
  leftOnly: string[];
  rightOnly: string[];
  shared: string[];
  sharedOverLeft: number;
  sharedOverRight: number;
}

export type ConceptAssignability =
  | "left-to-right"
  | "right-to-left"
  | "both"
  | "neither";

export interface ConceptConversion {
  file: string;
  from: string;
  function: string;
  to: string;
}

export interface ConceptOverlapUsageContext {
  sharedConsumers: string[];
  sharedModules: string[];
}

export interface ConceptOverlapDistributionContext {
  packageJaccard: number;
  sharedModules: string[];
  sharedPackages: string[];
}

export interface ConceptOverlapTemporalContext {
  coChangeCommits: number;
  context: CouplingContext;
  jaccard: number;
  leftConditional: number;
  rightConditional: number;
  staticPath: StaticPathRelation;
}

export type ConceptOverlapShape =
  | "near-equivalent"
  | "projection-like"
  | "conversion-pair"
  | "structurally-overlapping";

export interface ConceptOverlapCandidate {
  assignability?: ConceptAssignability;
  bidirectionalConversion: boolean;
  conversions: ConceptConversion[];
  crossPackage: boolean;
  dimensions: ConceptOverlapDimension[];
  distributionContext?: ConceptOverlapDistributionContext;
  evidence: ConceptOverlapEvidence[];
  left: ConceptIdentity;
  name?: ConceptNameAffinity;
  right: ConceptIdentity;
  shapes: ConceptOverlapShape[];
  structure?: ConceptPropertyOverlap;
  temporalContext?: ConceptOverlapTemporalContext;
  usage?: ConceptOverlapUsageContext;
}

interface ConceptOverlapGeneration {
  candidates: number;
  indexedDeclarations: number;
  pairsCompared: number;
  pairsGenerated: {
    name: number;
    property: number;
    conversion: number;
    temporal: number;
    total: number;
  };
  seeds: number;
}

interface ConceptOverlapSummary {
  bidirectionalConversionPairs: number;
  candidates: number;
  conversionPairs: number;
  crossPackageCandidates: number;
  nearEquivalent: number;
  projectionLike: number;
  structurallyOverlapping: number;
}

export interface ConceptOverlapReport {
  candidates: ConceptOverlapCandidate[];
  generation: ConceptOverlapGeneration;
  summary: ConceptOverlapSummary;
  target: string;
}

export type OwnershipDimension =
  | "declaration"
  | "representation"
  | "implementation"
  | "reference"
  | "behavior"
  | "conversion"
  | "evolution"
  | "architecture"
  | "intent";

export type OwnershipRole =
  | "semantic-center"
  | "implementation-center"
  | "usage-center"
  | "representation-center"
  | "behavior-center"
  | "evolution-center";

export interface OwnershipEvidence {
  dimension: OwnershipDimension;
  metric: string;
  package: string;
  value: number | string | boolean;
}

export interface ConceptBehaviorDistribution {
  byPackage: {
    package: string;
    functions: number;
    methods: number;
    constructors: number;
    contract: number;
    implementation: number;
    share: number;
    kinds: Partial<
      Record<ChurnFileKind, { contract: number; implementation: number }>
    >;
  }[];
  contractTotal: number;
  participants: ConceptBehaviorParticipant[];
  total: number;
}

export interface ConceptBehaviorParticipant {
  file: string;
  kind: ChurnFileKind;
  lines?: { start: number; end: number };
  member: "function" | "method" | "constructor";
  package: string;
  role: "contract" | "implementation";
  symbol: string;
}

export interface ConceptRepresentationKinds {
  kinds: Partial<Record<ChurnFileKind, number>>;
  package: string;
}

export interface ConceptEvolutionCoupling {
  aggregatorMediated: boolean;
  coChangeCommits: number;
  conditional: number;
  context: CouplingContext;
  file: string;
  jaccard: number;
  partnerConditional: number;
  partnerFile: string;
  partnerPackage: string;
  staticPath: StaticPathRelation;
}

export interface ConceptEvolutionEvidence {
  changedRepresentationFiles: number;
  commits: number;
  couplings: ConceptEvolutionCoupling[];
  hotspotRepresentations: number;
  hotspots: { file: string; commits: number; commitPercentile: number }[];
  package: string;
  strongCouplingPairs: number;
  support: number;
  supportingCouplingPairs: number;
}

export interface ConceptOwnershipCandidate {
  dimensions: OwnershipDimension[];
  evidence: OwnershipEvidence[];
  package: string;
  participation: {
    representations: number;
    implementations: number;
    references: number;
    behaviors: number;
    conversions: number;
  };
  roles: OwnershipRole[];
}

export interface ConceptOwnershipCenter {
  behavior?: string;
  evolution?: string;
  implementations: string[];
  representation?: string;
  semantic?: string;
  usage?: string;
}

export type OwnershipAlignment =
  | "aligned"
  | "distributed"
  | "divergent"
  | "insufficient-evidence";

export type ConceptOwnershipTensionKind =
  | "seed-vs-behavior"
  | "seed-vs-representation"
  | "seed-vs-evolution"
  | "usage-vs-semantic-center"
  | "anchor-vs-observed-center";

export interface ConceptOwnershipTension {
  kind: ConceptOwnershipTensionKind;
  observedPackage: string;
  seedPackage: string;
  value: number;
}

type OwnershipCautionKind =
  | "sparse-history"
  | "anchored-seed"
  | "no-implementation-evidence";

export interface OwnershipCaution {
  detail: string;
  kind: OwnershipCautionKind;
}

export interface ConceptOwnershipOverlapContext {
  conversionPackages: string[];
  other: ConceptIdentity;
  representationBoundary: boolean;
}

export interface ConceptOwnershipAnalysis {
  alignment: OwnershipAlignment;
  behavior: ConceptBehaviorDistribution;
  candidates: ConceptOwnershipCandidate[];
  cautions: OwnershipCaution[];
  center: ConceptOwnershipCenter;
  concept: ConceptIdentity;
  evolution?: ConceptEvolutionEvidence[];
  overlap: ConceptOwnershipOverlapContext[];
  representationKinds: ConceptRepresentationKinds[];
  tensions: ConceptOwnershipTension[];
}

interface ConceptOwnershipSummary {
  aligned: number;
  analyzed: number;
  distributed: number;
  divergent: number;
  insufficientEvidence: number;
  tensions: number;
}

export interface ConceptOwnershipReport {
  concepts: ConceptOwnershipAnalysis[];
  summary: ConceptOwnershipSummary;
  target: string;
}

export type BehaviorRole = "contract" | "implementation" | "conversion";

export interface ConceptBehaviorPackage {
  behaviors: number;
  contractBehaviors: number;
  conversionBehaviors: number;
  implementationBehaviors: number;
  modules: number;
  package: string;
  sourceBehaviors: number;
  sourceModules: number;
  storyBehaviors: number;
  testBehaviors: number;
}

export interface ConceptBehaviorModule {
  behaviors: number;
  contractBehaviors: number;
  conversionBehaviors: number;
  implementationBehaviors: number;
  kind: ChurnFileKind;
  module: string;
  package: string;
  role?: ModuleRole["kind"];
}

export interface ConceptBehaviorMap {
  byModule: ConceptBehaviorModule[];
  byPackage: ConceptBehaviorPackage[];
  other: number;
  source: number;
  story: number;
  test: number;
  total: number;
}

export interface ConceptBehaviorSpan {
  boundaryEdges: { from: string; to: string }[];
  moduleCount: number;
  packageBoundaryCount: number;
  packageCount: number;
  sourceModuleCount: number;
  sourcePackageCount: number;
}

export interface ConceptDistance {
  from: string;
  inward?: number;
  outward?: number;
  to: string;
  viaAggregator?: boolean;
}

export interface ConceptTraversalContext {
  centerDistances: ConceptDistance[];
  disconnectedModules: number;
  disconnectedPackagePairs: number;
  maxModuleDistance: number | null;
  maxPackageDistance: number | null;
  moduleDistances: ConceptDistance[];
  origin: { package: string; module: string };
  packageDistances: ConceptDistance[];
  participatingModules: string[];
  participatingPackages: string[];
}

interface ConceptChangeSurface {
  converterModules: number;
  hotspotModules: number;
  implementationModules: number;
  packages: number;
  sourceModules: number;
  stronglyCoupledBehaviorModules: number;
}

interface ConceptReferenceHalo {
  modules: number;
  packages: number;
  references: number;
}

interface ConceptBehaviorConcentration {
  primaryModule?: string;
  primaryModuleShare: number | null;
  primaryPackage?: string;
  primaryPackageShare: number | null;
}

export interface ConceptBehaviorCoupling {
  aggregatorMediated: boolean;
  coChangeCommits: number;
  context: CouplingContext;
  jaccard: number;
  left: string;
  leftConditional: number;
  right: string;
  rightConditional: number;
  staticPath: StaticPathRelation;
}

export interface ConceptExternalCompanion {
  coChangeCommits: number;
  context: CouplingContext;
  external: string;
  externalPackage: string;
  module: string;
}

export interface ConceptBehaviorTemporalContext {
  externalCompanions: ConceptExternalCompanion[];
  hotspots: { module: string; commits: number; commitPercentile: number }[];
  internalCouplings: ConceptBehaviorCoupling[];
}

export type BehavioralLocalityShape =
  | "local"
  | "single-package-distributed"
  | "cross-package-localized"
  | "cross-package-distributed"
  | "behavior-light"
  | "insufficient-evidence";

export type BehavioralLocalityModifier = "parallel-implementations";

type BehavioralLocalityCautionKind =
  | "structural-conformance-unobserved"
  | "test-heavy-behavior"
  | "sparse-source-behavior"
  | "disconnected-static-path"
  | "target-scoped-history";

export interface BehavioralLocalityCaution {
  detail: string;
  kind: BehavioralLocalityCautionKind;
}

export interface ConceptBehavioralLocality {
  anchored: boolean;
  behavior: ConceptBehaviorMap;
  cautions: BehavioralLocalityCaution[];
  changeSurface: ConceptChangeSurface;
  concentration: ConceptBehaviorConcentration;
  concept: ConceptIdentity;
  distribution: {
    representation: { package?: string; share: number | null };
    usage: { package?: string; share: number | null };
  };
  halo: ConceptReferenceHalo;
  shape: {
    primary: BehavioralLocalityShape;
    modifiers: BehavioralLocalityModifier[];
  };
  span: ConceptBehaviorSpan;
  temporal?: ConceptBehaviorTemporalContext;
  traversal: ConceptTraversalContext;
}

interface ConceptBehavioralLocalitySummary {
  analyzed: number;
  behaviorLight: number;
  crossPackageDistributed: number;
  crossPackageLocalized: number;
  insufficientEvidence: number;
  local: number;
  parallelImplementations: number;
  singlePackageDistributed: number;
}

export interface ConceptBehavioralLocalityReport {
  concepts: ConceptBehavioralLocality[];
  summary: ConceptBehavioralLocalitySummary;
  target: string;
}

export type RecenteringDimension =
  | "ownership"
  | "behavior"
  | "representation"
  | "implementation"
  | "evolution"
  | "dependency"
  | "boundary"
  | "locality"
  | "intent";

export type RecenteringTension =
  | "semantic-vs-behavior"
  | "semantic-vs-representation"
  | "semantic-vs-evolution"
  | "behavioral-scatter"
  | "implementation-scatter"
  | "boundary-friction"
  | "dependency-misalignment"
  | "temporal-misalignment"
  | "anchor-conflict";

type RecenteringEvidenceSource =
  | "concept-ownership"
  | "concept-locality"
  | "concept-distribution"
  | "concept-overlap"
  | "boundary-interaction"
  | "gravity"
  | "change-coupling"
  | "hotspots"
  | "anchor";

export interface RecenteringEvidence {
  dimension: RecenteringDimension;
  kind: string;
  package?: string;
  source: RecenteringEvidenceSource;
  value: number | string | boolean | string[];
}

interface RecenteringSubject {
  concept: ConceptIdentity;
  kind: "concept-family";
}

export interface CurrentArchitecturalPlacement {
  behaviorPackages: string[];
  evolutionCenter?: string;
  implementationCenters: string[];
  representationCenter?: string;
  seedPackage: string;
  semanticCenter?: string;
  usageCenter?: string;
}

export type RecenteringBehaviorEvidenceKind =
  | "implementation"
  | "conversion"
  | "construction"
  | "return"
  | "parameter-consumer";

export interface RecenteringBehaviorProfile {
  byKind: Record<RecenteringBehaviorEvidenceKind, number>;
  byPackage: {
    package: string;
    strong: number;
    weak: number;
    byKind: Record<RecenteringBehaviorEvidenceKind, number>;
  }[];
  primaryStrongPackage?: string;
  primaryStrongShare: number | null;
  source: number;
  strong: number;
  strongModules: number;
  topTwoStrongModuleShare: number | null;
  weak: number;
}

export interface RecenteringLocalityContext {
  disconnectedModules: number;
  disconnectedPackagePairs: number;
  maxModuleDistance: number | null;
  modifiers: BehavioralLocalityModifier[];
  primaryPackageShare: number | null;
  shape: BehavioralLocalityShape;
  sourceBehaviors: number;
  sourceModules: number;
  sourcePackages: number;
  topTwoModuleShare: number | null;
}

export interface RecenteringHistoricalContext {
  crossPackageCouplings: {
    left: string;
    right: string;
    leftPackage: string;
    rightPackage: string;
    coChangeCommits: number;
  }[];
  evolutionCenter?: string;
  hotspotModules: number;
  internalSourceCouplings: number;
}

export interface RepresentationBoundaryContext {
  converterPackages: string[];
  explicitBidirectionalConversion: boolean;
  overlappingConcept?: ConceptIdentity;
  structuralOverlap?: number;
}

export interface RecenteringIntentContext {
  anchoredObservedPackages: string[];
  anchorReason?: string;
  representationBoundaries: RepresentationBoundaryContext[];
  seedAnchored: boolean;
}

export type RecenteringCandidateShape =
  | "mis-centered"
  | "behaviorally-scattered"
  | "representation-drift"
  | "implementation-drift"
  | "boundary-strained"
  | "intent-protected";

export type RecenteringStatus =
  | "candidate"
  | "protected"
  | "insufficient-evidence";

type RecenteringCautionKind =
  | "parameter-consumer-dominated"
  | "sparse-strong-behavior"
  | "behaviorally-concentrated"
  | "representation-boundary"
  | "test-heavy-behavior"
  | "structural-conformance-unobserved"
  | "target-scoped-history";

export interface RecenteringCaution {
  detail: string;
  kind: RecenteringCautionKind;
}

export interface RecenteringCandidate {
  behavior: RecenteringBehaviorProfile;
  cautions: RecenteringCaution[];
  currentPlacement: CurrentArchitecturalPlacement;
  dimensions: RecenteringDimension[];
  evidence: RecenteringEvidence[];
  history?: RecenteringHistoricalContext;
  id: string;
  intent: RecenteringIntentContext;
  locality: RecenteringLocalityContext;
  shapes: RecenteringCandidateShape[];
  status: RecenteringStatus;
  strongTensions: RecenteringTension[];
  subject: RecenteringSubject;
  tensions: RecenteringTension[];
}

export interface RecenteringCandidateSummary {
  byShape: Record<RecenteringCandidateShape, number>;
  byTension: Record<RecenteringTension, number>;
  candidates: number;
  evaluated: number;
  insufficientEvidence: number;
  protected: number;
}

export interface RecenteringCandidateReport {
  candidates: RecenteringCandidate[];
  impacts: ScenarioImpactReport;
  miscentered: MiscenteredConceptReport;
  reviews: ArchitecturalReviewReport;
  scenarios: RecenteringScenarioReport;
  summary: RecenteringCandidateSummary;
  target: string;
}

export type MiscenteringEvidenceKind =
  | "consumer-gravity"
  | "dependency-gravity"
  | "symbol-distribution"
  | "behavioral-locality"
  | "boundary-crossing"
  | "concept-distribution"
  | "ownership";

export type MiscenteringGravityFamily =
  | "behavioral-locality"
  | "symbol-distribution"
  | "consumer-gravity";

export type MiscenteringSignal =
  | "external-gravity"
  | "split-gravity"
  | "boundary-drift";

export interface MiscenteringEvidence {
  kind: MiscenteringEvidenceKind;
  metric: string;
  package?: string;
  source: RecenteringEvidenceSource;
  supports: boolean;
  value: number | string | string[];
}

export interface DeclaredHome {
  anchored: boolean;
  anchorReason?: string;
  module: string;
  package: string;
}

export interface ObservedCenter {
  anchored: boolean;
  gravity: number;
  shares: Partial<Record<MiscenteringGravityFamily, number>>;
  target: string;
}

type MiscenteringCautionKind =
  | "declared-home-anchored"
  | "observed-center-anchored"
  | "adapter-implementations"
  | "unobserved-conformance"
  | "consumption-heavy"
  | "representation-boundary";

export interface MiscenteringCaution {
  detail: string;
  kind: MiscenteringCautionKind;
}

export interface MiscenteredConceptFinding {
  anchored: boolean;
  cautions: MiscenteringCaution[];
  concept: ConceptIdentity;
  declaredHome: DeclaredHome;
  evidence: MiscenteringEvidence[];
  evidenceConfidence: number;
  gravityFamilies: MiscenteringGravityFamily[];
  id: string;
  mismatch: number;
  observedCenters: ObservedCenter[];
  signal: MiscenteringSignal;
  summary: string;
  supportingFamilies: MiscenteringEvidenceKind[];
  weights: Partial<Record<MiscenteringGravityFamily, number>>;
}

export type MiscenteringOutcome =
  | "finding"
  | "aligned"
  | "behavior-light"
  | "usage-only"
  | "unclear";

export interface MiscenteredConceptSummary {
  anchored: number;
  bySignal: Record<MiscenteringSignal, number>;
  evaluated: number;
  findings: number;
  outcomes: Record<MiscenteringOutcome, number>;
}

export interface MiscenteredConceptReport {
  assessed: { concept: ConceptIdentity; outcome: MiscenteringOutcome }[];
  findings: MiscenteredConceptFinding[];
  summary: MiscenteredConceptSummary;
  target: string;
}

export type ScenarioResponsibility =
  | "semantic-contract"
  | "domain-behavior"
  | "implementation"
  | "persistence"
  | "representation"
  | "conversion"
  | "integration"
  | "consumption";

export interface ScenarioPlacement {
  responsibilities: {
    responsibility: ScenarioResponsibility;
    packages: string[];
  }[];
  semanticCenter: string;
}

export type RecenteringScenarioKind =
  | "preserve-current"
  | "rehome-semantic-center"
  | "rehome-behavior"
  | "consolidate-behavior"
  | "formalize-representation-boundary"
  | "split-responsibility";

export interface ScenarioCandidateCenter {
  anchored: boolean;
  package: string;
  reasons: {
    semantic?: boolean;
    behavior?: number;
    representation?: number;
    implementation?: number;
    evolution?: boolean;
    conversion?: number;
    supportingFamilies?: number;
  };
}

export type ScenarioConstraint =
  | { kind: "anchor"; package: string; reason: string }
  | { kind: "representation-boundary"; concepts: string[] }
  | { kind: "structural-conformance-unknown"; concept: string }
  | { kind: "public-contract"; package: string };

type RecenteringScenarioEvidenceKind =
  | "declared-home"
  | "governing-behavior-center"
  | "representation-center"
  | "implementation-center"
  | "supporting-family-center"
  | "conversion-boundary"
  | "localized-current-split"
  | "anchor"
  | "public-contract"
  | "boundary-context";

export interface RecenteringScenarioEvidence {
  detail: string | number | boolean;
  kind: RecenteringScenarioEvidenceKind;
  package?: string;
  supports: "preserve" | "rehome" | "consolidate" | "split";
}

export type ScenarioEvidenceConfidence = "strong" | "moderate" | "weak";

export type ScenarioStatus = "plausible" | "constrained" | "blocked";

type ScenarioCautionKind =
  | "counter-evidence"
  | "integration-center"
  | "unobserved-conformance"
  | "consumption-heavy"
  | "observed-center-anchored"
  | "composition-root-unknown";

export interface ScenarioCaution {
  detail: string;
  kind: ScenarioCautionKind;
}

interface ScenarioAnchorContext {
  anchoredCenters: string[];
  homeAnchored: boolean;
}

export interface RecenteringScenario {
  affectedResponsibilities: ScenarioResponsibility[];
  anchorContext: ScenarioAnchorContext;
  cautions: ScenarioCaution[];
  confidence: ScenarioEvidenceConfidence;
  constraints: ScenarioConstraint[];
  current: ScenarioPlacement;
  findingId: string;
  id: string;
  kind: RecenteringScenarioKind;
  preservedResponsibilities: ScenarioResponsibility[];
  proposed: ScenarioPlacement;
  rationale: RecenteringScenarioEvidence[];
  status: ScenarioStatus;
  subject: ConceptIdentity;
}

interface ScenarioGenerationDiagnostics {
  blocked: number;
  centersConsidered: number;
  deduplicated: number;
  noAlternativeReason?: string;
  proposed: number;
  truncated: number;
}

export interface RecenteringScenarioFinding {
  candidateCenters: ScenarioCandidateCenter[];
  diagnostics: ScenarioGenerationDiagnostics;
  findingId: string;
  scenarios: RecenteringScenario[];
  signal: MiscenteringSignal;
  subject: ConceptIdentity;
}

export interface RecenteringScenarioSummary {
  baselineOnly: number;
  blocked: number;
  blockedByAnchor: number;
  byDestination: Record<string, number>;
  byKind: Record<RecenteringScenarioKind, number>;
  candidateCenters: { one: number; two: number; threePlus: number };
  constrained: number;
  constrainedByIncompleteEvidence: number;
  findings: number;
  findingsWithAlternatives: number;
  plausible: number;
  scenarios: number;
  scenariosPerFinding: { max: number; p50: number; p90: number };
  skipped: Record<Exclude<MiscenteringOutcome, "finding">, number>;
}

export interface RecenteringScenarioReport {
  findings: RecenteringScenarioFinding[];
  summary: RecenteringScenarioSummary;
  target: string;
}

export type ImpactCertainty = "certain" | "conditional" | "unknown";

export interface ScenarioMetricDelta {
  certainty: ImpactCertainty;
  current: number | null;
  delta: number | null;
  predicted: number | null;
}

interface ScenarioDirectionalDelta {
  certainty: ImpactCertainty;
  direction: "increase" | "decrease" | "unchanged" | "unknown";
}

export interface ScenarioDependencyEdge {
  conceptImportSites: number | null;
  conceptModules: string[];
  exclusive: boolean;
  from: string;
  importSites: number | null;
  measured: boolean;
  to: string;
}

export type ScenarioBoundaryOutcome =
  | "eliminated"
  | "reduced"
  | "preserved"
  | "added"
  | "uncertain";

export interface ScenarioBoundaryState {
  certainty: ImpactCertainty;
  conceptImportSites: number | null;
  conceptImportSitesRemoved: number | null;
  conceptInteractionEnds: boolean;
  edge: string;
  exclusive: boolean;
  from: string;
  importSites: number | null;
  outcome: ScenarioBoundaryOutcome;
  remainingModules: string[];
  to: string;
  vacatedModules: string[];
}

export interface BoundaryReduction {
  certainty: ImpactCertainty;
  conceptImportSitesRemoved: number;
  conceptInteractionEnds: boolean;
  edge: string;
  remainingModules: number;
}

export interface DependencyImpact {
  added: ScenarioDependencyEdge[];
  currentEdges: ScenarioDependencyEdge[];
  packageFanInDelta: ScenarioMetricDelta;
  packageFanOutDelta: ScenarioMetricDelta;
  predictedEdges: ScenarioDependencyEdge[];
  preserved: ScenarioDependencyEdge[];
  removed: ScenarioDependencyEdge[];
  uncertain: ScenarioDependencyEdge[];
}

export interface BoundaryImpact {
  added: string[];
  conceptModulesDelta: ScenarioMetricDelta;
  current: ScenarioBoundaryState[];
  eliminated: string[];
  importSitesDelta: ScenarioMetricDelta;
  predicted: ScenarioBoundaryState[];
  preserved: string[];
  reduced: BoundaryReduction[];
}

export interface LocalitySnapshot {
  behavioralBoundaryEdges: number | null;
  disconnectedPackagePairs: number | null;
  maxTraversalDistance: number | null;
  shape?: BehavioralLocalityShape;
  sourceModuleCount: number | null;
  sourcePackageCount: number;
  sourcePackages: string[];
}

export interface LocalityImpact {
  behavioralBoundaryEdges: ScenarioMetricDelta;
  current: LocalitySnapshot;
  disconnectedBehaviorPairs: ScenarioMetricDelta;
  maxTraversalDistance: ScenarioDirectionalDelta;
  predicted: LocalitySnapshot;
  shapeTransition: {
    from: BehavioralLocalityShape;
    to?: BehavioralLocalityShape;
    certainty: ImpactCertainty;
  };
  sourceModuleCount: ScenarioMetricDelta;
  sourcePackageCount: ScenarioMetricDelta;
}

export interface ScenarioBehaviorPlacement {
  conversion: number | null;
  governing: number | null;
  implementation: number | null;
  package: string;
  weak: number;
}

export interface BehaviorImpact {
  certainty: ImpactCertainty;
  consumerBehaviorUnaffected: number;
  currentByPackage: ScenarioBehaviorPlacement[];
  governingBehaviorPreserved: number;
  governingBehaviorRelocated: number;
  governingBehaviorUnplaced: number;
  packagesAdded: string[];
  packagesRemoved: string[];
  predictedByPackage: ScenarioBehaviorPlacement[];
}

export interface SurfaceImpact {
  consumers: {
    packages: string[];
    packagePublic: boolean;
    externallyUsed: boolean;
    impact: "unaffected" | "unresolved";
  };
  currentPublicPackages: string[];
  packagePublicContractRelocated: boolean;
  predictedPublicPackages: string[];
  publicExposureAdded: string[];
  publicExposureRemoved: string[];
  reexportRequirement?: ImpactCertainty;
  surfaceCautions: string[];
}

export interface RepresentationImpact {
  certainty: ImpactCertainty;
  convertersPreserved: string[];
  overlapPairsAffected: string[];
  persistenceRepresentationsPreserved: string[];
  representationBoundariesAdded: string[];
  representationBoundariesRemoved: string[];
  semanticRepresentationsCurrent: string[];
  semanticRepresentationsPredicted: string[];
}

export interface ImplementationImpact {
  currentCenters: string[];
  parallelImplementationPreserved: boolean;
  predictedCenters: string[];
  preservedImplementations: string[];
  relocatedImplementationResponsibility: string[];
}

export interface EvolutionImpact {
  couplingRelationshipsCoLocated: number;
  couplingRelationshipsPreserved: number;
  couplingRelationshipsStillCrossBoundary: number;
  couplingRelationshipsUnknown: number;
  historicalEvidenceAlignment: "improves" | "unchanged" | "mixed" | "unknown";
  historicallyCoupledFilesAffected: number;
  hotspotBehaviorRelocated: number;
}

export interface IntentImpact {
  anchoredResponsibilitiesAdded: string[];
  anchoredResponsibilitiesRemoved: string[];
  anchorsPreserved: string[];
  anchorsViolated: string[];
  compatibility: "compatible" | "constrained" | "incompatible";
  publicBoundaryChanges: string[];
}

interface ScenarioImpactVector {
  behavior: BehaviorImpact;
  boundaries: BoundaryImpact;
  dependency: DependencyImpact;
  evolution: EvolutionImpact;
  implementation: ImplementationImpact;
  intent: IntentImpact;
  locality: LocalityImpact;
  representation: RepresentationImpact;
  surface: SurfaceImpact;
}

export type ScenarioStructuralChangeKind =
  | "semantic-center-change"
  | "behavior-center-change"
  | "behavior-consolidation"
  | "boundary-elimination"
  | "boundary-reduction"
  | "boundary-addition"
  | "dependency-elimination"
  | "dependency-addition"
  | "surface-relocation"
  | "representation-boundary-preserved"
  | "representation-boundary-added"
  | "implementation-split-preserved"
  | "anchor-constraint";

type ScenarioImpactEvidenceSource =
  | "scenario"
  | "boundary-interaction"
  | "dependency-gravity"
  | "concept-locality"
  | "concept-distribution"
  | "concept-overlap"
  | "concept-ownership"
  | "change-coupling"
  | "hotspots"
  | "surface"
  | "anchor";

interface ScenarioImpactEvidence {
  detail: string;
  source: ScenarioImpactEvidenceSource;
}

export interface ScenarioStructuralChange {
  certainty: ImpactCertainty;
  evidence: ScenarioImpactEvidence[];
  from?: string | number | string[];
  kind: ScenarioStructuralChangeKind;
  to?: string | number | string[];
}

export type ScenarioPreservationKind =
  | "semantic-center"
  | "implementation-split"
  | "persistence-boundary"
  | "anchor"
  | "public-contract"
  | "consumer-boundary";

export interface ScenarioPreservation {
  detail: string;
  kind: ScenarioPreservationKind;
}

export type ScenarioImpactUncertaintyKind =
  | "target-module-unknown"
  | "consumer-compatibility-unknown"
  | "structural-conformance-unobserved"
  | "composition-root-remains"
  | "shared-boundary-edge"
  | "surface-transition-unspecified"
  | "historical-future-assumption";

export interface ScenarioImpactUncertainty {
  detail: string;
  kind: ScenarioImpactUncertaintyKind;
}

export interface ScenarioConstraintImpact {
  consequence: string;
  constraint: ScenarioConstraint;
}

export type ScenarioImpactStatus =
  | "simulated"
  | "partially-simulated"
  | "blocked";

export interface ScenarioImpactAnalysis {
  baseline: ScenarioPlacement;
  certainty: { certain: number; conditional: number; unknown: number };
  changes: ScenarioStructuralChange[];
  concept: ConceptIdentity;
  constraints: ScenarioConstraintImpact[];
  findingId: string;
  impact: ScenarioImpactVector;
  kind: RecenteringScenarioKind;
  preserved: ScenarioPreservation[];
  proposed: ScenarioPlacement;
  scenarioId: string;
  status: ScenarioImpactStatus;
  summary: string[];
  uncertainties: ScenarioImpactUncertainty[];
}

export interface ScenarioImpactFinding {
  findingId: string;
  scenarios: ScenarioImpactAnalysis[];
  subject: ConceptIdentity;
}

export interface ScenarioImpactSummary {
  anchorConflicts: number;
  blocked: number;
  boundaryAdditions: number;
  boundaryEliminations: number;
  boundaryReductions: number;
  certainChanges: number;
  conditionalChanges: number;
  dependencyEliminations: number;
  localityDecreases: number;
  localityIncreases: number;
  partiallySimulated: number;
  representationBoundariesPreserved: number;
  runtimeMs: number;
  scenarios: number;
  simulated: number;
  surfaceRelocations: number;
  unknownConsequences: number;
}

export interface ScenarioImpactReport {
  findings: ScenarioImpactFinding[];
  summary: ScenarioImpactSummary;
  target: string;
}

export type ArchitecturalReviewDimension =
  | "dependency"
  | "boundary"
  | "locality"
  | "surface"
  | "behavior"
  | "representation"
  | "implementation"
  | "evolution"
  | "intent"
  | "uncertainty";

export interface ArchitecturalReviewEvidence {
  certainty: ImpactCertainty;
  detail: string;
  dimension: ArchitecturalReviewDimension;
  kind: string;
  sourceScenarioId: string;
}

export type ReviewedScenarioStatus =
  | "baseline"
  | "viable"
  | "dominated"
  | "invalid"
  | "indistinguishable"
  | "insufficient-evidence";

export type ReviewEvidenceCompleteness = "strong" | "partial" | "weak";

export type ArchitecturalScenarioEffect =
  | "center-alignment"
  | "locality-contraction"
  | "boundary-reduction"
  | "dependency-reduction"
  | "responsibility-clarification"
  | "surface-relocation"
  | "representation-preservation"
  | "intent-conflict";

export type ArchitecturalScenarioCharacter =
  | "structural-reduction"
  | "relocation"
  | "clarification"
  | "no-change";

export interface ReviewedScenario {
  character: ArchitecturalScenarioCharacter;
  constraints: ScenarioConstraintImpact[];
  costs: ArchitecturalReviewEvidence[];
  effects: ArchitecturalScenarioEffect[];
  evidenceCompleteness: ReviewEvidenceCompleteness;
  intentCompatibility: IntentImpact["compatibility"];
  kind: RecenteringScenarioKind;
  preservations: ArchitecturalReviewEvidence[];
  scenarioId: string;
  status: ReviewedScenarioStatus;
  strengths: ArchitecturalReviewEvidence[];
  uncertainties: ArchitecturalReviewEvidence[];
}

export type ScenarioDimensionRelation =
  | "left-better"
  | "right-better"
  | "equivalent"
  | "tradeoff"
  | "unknown";

export interface ScenarioDimensionComparison {
  certainty: ImpactCertainty;
  dimension: ArchitecturalReviewDimension;
  evidence: string[];
  relation: ScenarioDimensionRelation;
}

type ScenarioComparisonResult =
  | "left-dominates"
  | "right-dominates"
  | "tradeoff"
  | "equivalent"
  | "insufficient-evidence";

export interface ScenarioComparison {
  dimensions: ScenarioDimensionComparison[];
  leftScenarioId: string;
  result: ScenarioComparisonResult;
  rightScenarioId: string;
}

export interface ArchitecturalTradeoff {
  costs: { dimension: ArchitecturalReviewDimension; evidence: string }[];
  gains: { dimension: ArchitecturalReviewDimension; evidence: string }[];
  scenarioId: string;
}

export interface DominatedScenario {
  dimensions: ArchitecturalReviewDimension[];
  dominatedBy: string;
  evidence: string[];
  scenarioId: string;
}

export type ArchitecturalReviewUncertaintyKind =
  | "partial-simulation"
  | "conditional-evidence-only"
  | "unknown-dimension"
  | "indistinguishable-scenarios";

export interface ArchitecturalReviewUncertainty {
  detail: string;
  kind: ArchitecturalReviewUncertaintyKind;
  scenarioIds: string[];
}

export type ArchitecturalReviewDisposition =
  | "preserve-current"
  | "credible-alternative"
  | "multiple-tradeoffs"
  | "intent-blocked"
  | "insufficient-evidence";

export interface ArchitecturalScenarioReview {
  baselineScenarioId: string;
  comparisons: ScenarioComparison[];
  concept: ConceptIdentity;
  disposition: ArchitecturalReviewDisposition;
  dominated: DominatedScenario[];
  findingId: string;
  invalid: string[];
  rationale: string[];
  scenarios: ReviewedScenario[];
  signal: MiscenteringSignal;
  summary: string;
  tradeoffs: ArchitecturalTradeoff[];
  unresolved: ArchitecturalReviewUncertainty[];
  viable: string[];
}

export interface ArchitecturalReviewSummary {
  credibleAlternative: number;
  dominated: number;
  dominatedBaselines: number;
  findingsReviewed: number;
  indistinguishable: number;
  insufficientEvidence: number;
  insufficientEvidenceScenarios: number;
  intentBlocked: number;
  invalid: number;
  multipleTradeoffs: number;
  preserveCurrent: number;
  runtimeMs: number;
  scenariosReviewed: number;
  viable: number;
}

export interface ArchitecturalReviewReport {
  reviews: ArchitecturalScenarioReview[];
  summary: ArchitecturalReviewSummary;
  target: string;
}

export interface SurfaceReport {
  anchor?: { target: string; reason?: string };
  architecturalProfile: ArchitecturalProfileReport;
  boundaryInteractions: BoundaryInteractionReport;
  changeCoupling: ChangeCouplingReport;
  changeRadius: ChangeRadiusReport;
  churn: ChurnReport;
  conceptBehavioralLocality: ConceptBehavioralLocalityReport;
  conceptInventory: ConceptInventoryReport;
  conceptOverlap: ConceptOverlapReport;
  conceptOwnership: ConceptOwnershipReport;
  dependencies: SurfaceDependencies;
  dependencyGravity: DependencyGravityReport;
  evolutionaryPressure: EvolutionaryPressureReport;
  hotspots: HotspotReport;
  ineligibleOperations: IneligibleOperation[];
  localComplexity: LocalComplexityReport;
  operators: OperatorSummary[];
  opportunities: ReductionOpportunity[];
  plans: ReductionPlan[];
  policyVersion: number;
  recenteringCandidates: RecenteringCandidateReport;
  schemaVersion: 35;
  structuralPressure: StructuralPressureReport;
  summary: SurfaceSummary;
  symbols: SurfaceSymbol[];
  target: {
    name?: string;
    path: string;
    boundaryType: "package" | "directory";
  };
}

export interface AnalyzeSurfaceOptions {
  config?: AnalysisConfig;
  now?: Date;
  profile?: AnalysisProfile;
  root?: string;
  target: string;
  tsconfig?: string;
}

export type AnalysisProfile = "full" | "temporal";
