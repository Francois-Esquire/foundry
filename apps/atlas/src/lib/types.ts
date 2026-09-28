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

/** External usage of one symbol from one consumer module. */
export interface ConsumerModuleUsage {
  importSites: number;
  /** Root-relative consumer file. */
  module: string;
  /** Owning package of the consumer file. */
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
  /** Exported from its source module. Not the same as package-public. */
  exported: boolean;
  externalImportSites: number;
  externalReferences: number;
  id: string;
  kind: SymbolKind;
  name: string;
  /**
   * Reachable through a declared package entrypoint (root or subpath,
   * following re-export chains). False for module-only exports — symbols
   * exported purely for internal module composition. When the public surface
   * cannot be enumerated (wildcard exports, directory boundary), every module
   * export conservatively counts as package-public.
   */
  packagePublic: boolean;
  primaryConsumerShare: number;
  usageContexts: Partial<Record<UsageContext, number>>;
  usageNamespace: UsageNamespace;
}

interface SurfaceSummary {
  /** Package-public symbols / total symbols. */
  declaredSurfaceRatio: number;
  /** Externally used package-public symbols / package-public symbols. */
  exportUtilization: number;
  /** Package-public symbols with external usage. */
  externallyUsedSymbols: number;
  /** Externally used package-public symbols / total symbols. */
  externalSurfaceRatio: number;
  /** Symbols exported from their source module (package-public or not). */
  moduleExportedSymbols: number;
  /** Module exports with no package-public route: internal module composition. */
  moduleOnlyExports: number;
  /** Symbols reachable through the declared package entrypoints. */
  packagePublicSymbols: number;
  totalSymbols: number;
  /** Package-public symbols with zero external usage; may still be used internally. */
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
  /** Every import between the pair is `import type`; false as soon as one loads the module. */
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
  /** Share of the target's external references made by this consumer. */
  referenceShare: number;
  references: number;
  /** Share of the target's externally-used symbols this consumer touches. */
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
  /** Mean number of consumer packages per externally-used symbol. */
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

/**
 * A structural reduction opportunity derived from the V0/V1 data. An
 * opportunity only exists once its operation's hard eligibility gates pass;
 * weighted evidence never compensates for a failed gate.
 */
export interface ReductionOpportunity {
  cautions: ReductionCaution[];
  estimatedReduction: EstimatedReduction[];
  evidence: ReductionEvidence[];
  /**
   * Confidence that the observed deterministic structural evidence matches
   * this opportunity's detection model.
   *
   * This is not a probability that the suggested architectural action is
   * correct or should be performed.
   */
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

/**
 * A package-level operation whose hard eligibility gates failed for this
 * target — the "why not" behind an absent opportunity. Recorded only when the
 * target has at least one consumer.
 */
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

/** One way a symbol reaches the package-public API. */
export interface PublicExposureRoute {
  /** Files from the entrypoint to the declaration, including both ends. */
  chain: string[];
  /** Import specifier of the entrypoint (package name, or name/subpath). */
  entrypoint: string;
  /** Name the symbol is exposed under (may be a re-export alias). */
  exportedName: string;
  /** Root-relative path of the entrypoint source file. */
  file: string;
  kind: PublicRouteKind;
  line?: number;
  /** Entrypoint statement exposing the symbol; absent for direct declarations. */
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

/**
 * Signed prediction of summary-count changes if the plan were applied.
 * It models the package-public surface; since the summary now scopes its
 * export counts to package-public symbols, a re-run after applying a ready
 * internalize plan shows the predicted -1 (`packagePublicSymbols` /
 * `unusedExternalExports`) even when the declaring module keeps its own
 * `export` and the symbol becomes module-only.
 * All fields optional: each plan kind emits only the dimensions it predicts.
 */
export interface StructuralDelta {
  /** Package-public symbols (field name kept stable across schema versions). */
  exportedSymbols?: number;
  externallyUsedSymbols?: number;
  filesMoved?: number;
  importSitesRewritten?: number;
  packageBoundaries?: number;
  packageDependencyEdges?: number;
  totalSymbols?: number;
  unusedExternalExports?: number;
}

/**
 * A concrete, read-only structural plan for one internalize-symbol
 * opportunity: where the symbol becomes package-public, what would change,
 * what remains untouched, and the predicted surface delta. Descriptive only —
 * the tool never applies it.
 */
export interface InternalizeSymbolPlan {
  blockers: PlanBlocker[];
  evidence: ReductionEvidence[];
  /**
   * Stable hash of the input facts behind the plan (routes, statements,
   * blockers — not the derived delta). A mismatch against a fresh plan means
   * the facts moved: the plan is stale.
   */
  fingerprint: string;
  id: string;
  /** Attached after analysis; derived data, excluded from the fingerprint. */
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
  /** Package-relative directory the source could land in, when inferable. */
  directory?: string;
  package: string;
  /** Root-relative path of the destination package; absent when unresolved. */
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

/** Aggregate shape of the destination → source boundary relationship. */
interface FoldBoundaryUsage {
  consumedSymbols: number;
  importSites: number;
  moduleEdges: number;
  usageNamespace: UsageNamespace;
}

/**
 * A concrete, read-only fold plan for one fold-package opportunity: what
 * crosses the boundary, what would become internal, and the predicted
 * structural delta split into certain vs potential effects. Descriptive only.
 */
export interface FoldPackagePlan {
  blockers: PlanBlocker[];
  boundaryUsage: FoldBoundaryUsage;
  /** V2 opportunity cautions, carried so counter-evidence stays visible. */
  cautions: ReductionCaution[];
  consumedSurface: SymbolDependencyUsage[];
  /** Module edges from the destination package into the source package. */
  dependencyEdges: ModuleDependencyEdge[];
  destination: FoldDestination;
  evidence: ReductionEvidence[];
  /** Consumer packages other than the destination (empty under the current gate). */
  externalConsumers: string[];
  files: FoldFile[];
  /** Stable hash of the input facts behind the plan (see InternalizeSymbolPlan). */
  fingerprint: string;
  id: string;
  /** Attached after analysis; derived data, excluded from the fingerprint. */
  intelligence?: PlanIntelligence;
  operation: "fold-package";
  packageMetadata: PackageMetadataImpact[];
  plannedChanges: PlannedChange[];
  /**
   * Package-public source symbols that would stop being package-public: those
   * the destination consumes plus unused external exports. A superset of "consumed
   * only by the destination" — no claim they must become private.
   */
  potentiallyInternalized: string[];
  predictedDelta: { certain: StructuralDelta; potential: StructuralDelta };
  source: { package: string; path: string };
  status: PlanStatus;
}

export type ReductionPlan = InternalizeSymbolPlan | FoldPackagePlan;

/** Physical and semantic size of what a plan touches. */
export interface PlanScale {
  files: {
    total: number;
    source: number;
    test: number;
    config: number;
    other: number;
  };
  /** Imports crossing the affected boundary (zero for internalization). */
  imports: {
    sites: number;
    moduleEdges: number;
  };
  /** Symbol counts of the target package (fold: the source package). */
  symbols: {
    total: number;
    moduleExported: number;
    packagePublic: number;
    externallyUsed: number;
  };
}

/** Public-route burden of an internalization plan. */
interface PlanRouteBurden {
  supported: number;
  total: number;
  unsupported: number;
}

/** Public-surface shape of the target package, plus plan-specific counts. */
export interface PlanSurface {
  /**
   * Externally used / package-public symbols; null when nothing is
   * package-public. May differ from the destination-consumed count under
   * re-export attribution.
   */
  consumedSurfaceRatio: number | null;
  externallyUsedSymbols: number;
  moduleExportedSymbols: number;
  moduleOnlyExports: number;
  packagePublicSymbols: number;
  potentiallyInternalizedSymbols: number;
  /** Internalization plans only. */
  publicRoutes?: PlanRouteBurden;
  /** External references per destination-consumed symbol; fold plans only. */
  referenceDensity?: number | null;
  unusedExternalExports: number;
  /** Unused external exports / package-public symbols; null when nothing is package-public. */
  unusedExternalSurfaceRatio: number | null;
}

/** Direction of dependency flow across the fold boundary. */
interface PlanBoundaryFlow {
  cycle: boolean;
  destinationToSource: boolean;
  sourceToDestination: boolean;
}

/** The structural boundary a plan affects, from existing dependency data. */
export interface PlanBoundary {
  consumerPackages: number;
  dependencyPackages: number;
  /** Fold plans only. */
  flow?: PlanBoundaryFlow;
  importSitesCrossingBoundary: number;
  incomingDependencyEdges: number;
  moduleEdgesCrossingBoundary: number;
  outgoingDependencyEdges: number;
  packageBoundariesAffected: number;
}

/** Declared architectural context. Context, never judgment. */
export interface PlanIntent {
  anchored: boolean;
  anchors: { target: string; reason?: string }[];
  designedExports: boolean;
  publishable: boolean;
}

/** The plan's predicted delta split by certainty; one source of truth. */
interface PlanConsequence {
  certain: StructuralDelta;
  potential: StructuralDelta;
}

/**
 * Deterministic description of a plan's real scale, surface, boundary impact,
 * and architectural context — composed from existing analysis data, never
 * rescanned. Raw facts only: no size labels, no scores.
 */
export interface PlanIntelligence {
  boundary: PlanBoundary;
  consequence: PlanConsequence;
  intent: PlanIntent;
  scale: PlanScale;
  surface: PlanSurface;
}

type ValidationStatus = PlanStatus | "stale";

/** One deterministic fact a plan assumed; `holds` is its current truth. */
export interface PlanPrecondition {
  actual: string | number | boolean;
  expected: string | number | boolean;
  fact: string;
  holds: boolean;
}

/**
 * Result of re-checking a plan's assumptions against a fresh analysis.
 * `stale` means the facts moved between planning and now — never apply.
 */
export interface PlanValidation {
  blockers: PlanBlocker[];
  /** Fingerprint of the freshly rebuilt plan; absent when none exists. */
  currentFingerprint?: string;
  /** Fingerprint of the submitted plan. */
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

/** Compact per-operator state carried on the report (no plan duplication). */
export interface OperatorSummary {
  capabilities: OperatorCapabilities;
  id: string;
  opportunities: number;
  plans: { ready: number; blocked: number; unsupported: number };
  /**
   * Blocker-reason counts across unsupported plans: each unsupported plan
   * counts each of its distinct blocker reasons once, so a package-level
   * blocker (e.g. wildcard-exports) counts once per plan it invalidates.
   */
  unsupportedReasons: Record<string, number>;
}

export interface VerificationCheck {
  check: string;
  detail: string;
  status: "pass" | "fail";
}

/**
 * Proof that a mutation produced the predicted structural reduction. Deltas
 * use package-public semantics (route disappearance), matching the plan's
 * predicted delta — not the module-level summary counts.
 */
export interface VerificationResult {
  checks: VerificationCheck[];
  observedDelta: StructuralDelta;
  predictedDelta: StructuralDelta;
  status: "pass" | "fail";
}

export interface MutationResult {
  blockers?: PlanBlocker[];
  changedFiles: string[];
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

/**
 * Decision points: explicit alternate evaluation paths a reader must hold.
 * `total = controlFlow + expression`, where
 * `controlFlow = ifs + elseIfs + cases + loops + catches` (statement-level
 * branching) and `expression = ternaries + logical` (value-level branching —
 * the shape JSX conditional rendering takes). The split separates the two
 * reading burdens without losing the raw total. A switch itself adds nothing
 * (its cases carry the decisions); a default clause adds nothing (it is the
 * absence of a decision). Logical counts `&&`/`||` (and `??` when
 * configured); assignment forms (`&&=`) and optional chaining are not
 * counted.
 */
interface FunctionDecisions {
  cases: number;
  catches: number;
  /** ifs + elseIfs + cases + loops + catches. */
  controlFlow: number;
  defaults: number;
  /** `if` in an else position; counted in total, does not deepen nesting. */
  elseIfs: number;
  /** ternaries + logical. */
  expression: number;
  ifs: number;
  logical: number;
  loops: number;
  switches: number;
  ternaries: number;
  total: number;
}

interface FunctionParameters {
  /**
   * Parameters whose annotated type resolves to boolean (`boolean`,
   * `true | false`, or an alias/union of boolean literals). Unannotated
   * parameters are never counted — no name guessing, no contextual inference.
   */
  boolean: number;
  defaulted: number;
  optional: number;
  rest: number;
  total: number;
}

/** Explicit exit statements; nested function bodies are excluded. */
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

/**
 * Nested executable functions. Deliberately separate from control-flow
 * nesting: a callback is a different reading burden than an `if` ladder.
 */
interface FunctionCallbacks {
  /** Deepest function-in-function chain below this one (direct child = 1). */
  maxDepth: number;
  /** All function-like descendants, at any depth. */
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

/**
 * Local structural facts about one function, measured in a single AST walk.
 * Measurements stop at nested function boundaries: an inner function's body
 * contributes to its own record, never to the parent's decisions, nesting,
 * exits, or statements — the parent sees it only through `callbacks`.
 * Facts only; no score, no thresholds, no labels.
 */
export interface LocalComplexityMetrics {
  async: FunctionAsyncShape;
  callbacks: FunctionCallbacks;
  decisions: FunctionDecisions;
  exceptions: FunctionExceptions;
  exits: FunctionExits;
  loops: FunctionLoops;
  /**
   * Deepest control-flow nesting: `if` (except else-if), loops, `switch`,
   * and `try` each deepen by one; plain lexical blocks do not.
   */
  nesting: { max: number };
  parameters: FunctionParameters;
  /**
   * Executable statements in the body: every statement node except blocks,
   * type-only declarations (interface, type alias), and nested function
   * declarations. Not a LOC measure. Expression-bodied arrows report 0.
   */
  statements: number;
}

/**
 * One analyzed executable unit. `exported`/`packagePublic` hold when the
 * function is the direct implementation of a surface symbol — the declaration
 * itself, a variable initializer, or a member of a collected class. Nested
 * callbacks keep `ownerSymbolId` but report both flags false: a closure
 * inside a public function is not itself public API.
 */
export interface FunctionComplexity {
  exported: boolean;
  file: string;
  /** `file#L<line>C<col>#<name>` — stable across unrelated edits elsewhere. */
  id: string;
  kind: FunctionKind;
  line: number;
  metrics: LocalComplexityMetrics;
  name: string;
  ownerSymbolId?: string;
  packagePublic: boolean;
}

/** Nearest-rank percentiles: `sorted[ceil(q·n) − 1]` over ascending values. */
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

/** Descriptive aggregates over every analyzed function. No package score. */
export interface LocalComplexitySummary {
  /**
   * Control-flow decisions alone. The basis for higher-order policy:
   * expression decisions (`&&`, `||`, ternaries) stay descriptive so
   * JSX-heavy code never reads as branch-heavy.
   */
  controlFlowDecisions: MetricAggregate;
  /** Total decisions (control flow + expression) per function. */
  decisions: MetricAggregate;
  functionsAnalyzed: number;
  /** Aggregates of each function's max control-flow nesting. */
  nesting: MetricAggregate;
  parameters: MetricAggregate;
  statements: MetricAggregate;
}

export interface LocalComplexityReport {
  functions: FunctionComplexity[];
  summary: LocalComplexitySummary;
}

/**
 * Every internal module dependency the cruise observed across the workspace,
 * not just edges crossing the target boundary. Modules are root-relative
 * posix paths; owners maps each module to its owning workspace package name.
 * External npm dependencies are excluded from the cruise and therefore from
 * this graph — fan-out and reach describe internal workspace structure only.
 */
export interface WorkspaceModuleGraph {
  edges: ModuleDependencyEdge[];
  modules: string[];
  owners: Record<string, string>;
}

interface GravityNode {
  id: string;
  kind: "package" | "module";
}

/**
 * What a module's gravity is made of. An aggregator forwards other
 * modules' exports (`export … from`) at least as often as it declares
 * anything itself, so its fan-in is surface gravity, not an internal
 * center. Syntactic facts only; the name of the file plays no part.
 */
export interface ModuleRole {
  /** Resolved target of a declared package entrypoint. */
  entrypoint: boolean;
  kind: "aggregator" | "internal";
  /** Top-level declarations (functions, classes, variables, types, …). */
  ownDeclarations: number;
  /** `export … from` statements, plus `export { … }` lists made only of imported names. */
  reExports: number;
}

/**
 * Raw dependency-pressure measurements for one graph node. Facts only: no
 * score, no centrality, no importance label. All counts cover internal
 * workspace relationships — external npm dependencies are not in the graph.
 */
export interface DependencyGravity {
  /** Strongly connected component membership; size 0 when not in a cycle. */
  cycle: {
    member: boolean;
    size: number;
  };
  /**
   * Longest chain length in edges, measured on the strongly-connected-
   * component condensation: a cycle collapses to one step, so cyclic graphs
   * yield finite, stable depths and every member of a cycle shares its
   * component's depth. `downstream` follows dependent chains (how far
   * dependent pressure propagates toward this node); `upstream` follows
   * dependency chains (how far this node's dependencies propagate).
   */
  depth: {
    downstream: number;
    upstream: number;
  };
  /** Unique direct neighbors: dependents in, dependencies out. */
  direct: {
    fanIn: number;
    fanOut: number;
  };
  /** Module nodes only: what the path says the file is for. */
  fileKind?: FileKind;
  node: GravityNode;
  /**
   * Transitive counts normalized by the other nodes at the same level
   * (population − 1), as 0–1 fractions. 0 when the node is alone.
   */
  reach: {
    dependents: number;
    dependencies: number;
  };
  /** Module nodes only, when the source was parsed. */
  role?: ModuleRole;
  /**
   * Unique nodes reachable through the graph, excluding the node itself.
   * `dependents` walks incoming edges (everything that eventually relies on
   * this node); `dependencies` walks outgoing edges. Cycle-safe: each node
   * counts once.
   */
  transitive: {
    dependents: number;
    dependencies: number;
  };
}

/** One target module's share of the edges crossing the package boundary. */
export interface ModuleEdgeConcentration {
  edges: number;
  module: string;
  /** Fraction of all boundary-crossing edges in this direction. */
  share: number;
}

export interface DependencyGravityReport {
  /** Where incoming boundary edges land, largest share first. */
  incomingConcentration: ModuleEdgeConcentration[];
  /**
   * Directed edges between two target modules, sorted. Cross-boundary edges
   * live under `dependencies`; together they are the whole observed topology
   * of the package.
   */
  internalEdges: ModuleDependencyEdge[];
  /**
   * Every module of the target package, measured on the workspace-wide
   * module graph and sorted by file path.
   */
  modules: DependencyGravity[];
  /** Which target modules create outgoing boundary edges, largest first. */
  outgoingConcentration: ModuleEdgeConcentration[];
  /** Reach denominators: internal workspace packages and modules observed. */
  population: {
    packages: number;
    modules: number;
  };
  target: DependencyGravity;
}

/**
 * Descriptive architectural shapes. Each names a measured pattern in the
 * existing signals — never a quality judgment, never a recommendation. A
 * node may match several at once; matching none is normal.
 */
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

/** One matched profile shape and the exact metrics that satisfied its gates. */
export interface ArchitecturalProfileSignalResult {
  evidence: ArchitecturalProfileEvidence[];
  signal: ArchitecturalProfileSignal;
}

/** V5.0 gravity values, restated flat. No new formulas. */
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

/** Existing semantic-surface and consumer-distribution measurements. */
export interface ArchitecturalSurfaceProfile {
  averageSymbolDistribution: number;
  consumerPackages: number;
  declaredSurfaceRatio: number;
  exportUtilization: number;
  externallyUsedSymbols: number;
  externalSurfaceRatio: number;
  moduleOnlyExports: number;
  packagePublicSymbols: number;
  /** Primary consumer's reference share; absent with no consumers. */
  primaryConsumerShare?: number;
  totalSymbols: number;
  unusedExternalExports: number;
}

/** Package-level V4 complexity summary, restated. No re-scan. */
export interface ArchitecturalComplexityProfile {
  controlFlowDecisions: MetricDistribution;
  decisions: MetricDistribution;
  functionsAnalyzed: number;
  nesting: MetricDistribution;
  parameters: { p90: number; max: number };
  statements: { p90: number; max: number };
}

/**
 * Declared architectural context already known to the analysis. The optional
 * flags are tri-state: `true` means an existing opportunity/plan caution
 * proved the fact; absent means no analysis produced it — NOT false.
 */
export interface ArchitecturalIntentProfile {
  anchored: boolean;
  anchorReason?: string;
  designedExports?: boolean;
  publishable?: boolean;
}

/**
 * Composition of existing deterministic measurements into one architectural
 * description. Facts plus descriptive shape signals — no score, no
 * recommendation, no new scanning.
 */
interface ArchitecturalProfile {
  complexity: ArchitecturalComplexityProfile;
  gravity: ArchitecturalGravityProfile;
  intent: ArchitecturalIntentProfile;
  node: GravityNode;
  signals: ArchitecturalProfileSignalResult[];
  surface: ArchitecturalSurfaceProfile;
}

export interface ArchitecturalProfileReport {
  /** Module profiles are deferred; package profiles are the V5.1 scope. */
  modules?: ArchitecturalProfile[];
  target: ArchitecturalProfile;
}

/**
 * One module's part in a boundary's traffic. `share` is the module's import
 * sites over the boundary's import sites (0 when the boundary has none).
 * Modules that appear only as a cruiser edge endpoint (barrels) have 0 import
 * sites; modules that appear only as a declaring file have 0 module edges.
 */
export interface BoundaryModuleContribution {
  importSites: number;
  module: string;
  moduleEdges: number;
  /** Null on outgoing boundaries, where references are not measured. */
  references: number | null;
  share: number;
  symbols: number;
}

/**
 * Traffic across one internal package-to-package relationship. Import sites
 * use the V1 definition (one import/export specifier or default import that
 * names the symbol); destination modules are the symbols' declaring files,
 * not the imported barrel. Outgoing boundaries are measured from the target's
 * import declarations alone, so reference counts and surface coverage are
 * null there.
 */
export interface BoundaryInteraction {
  /** Distinct modules carrying at least one import site on each side. */
  breadth: { sourceModules: number; destinationModules: number };
  /** Largest single-module share of the boundary's import sites. */
  concentration: { sourceModuleShare: number; destinationModuleShare: number };
  destinationModules: BoundaryModuleContribution[];
  from: string;
  importSites: number;
  /** Unique module-to-module dependency edges crossing the boundary. */
  moduleEdges: number;
  sourceModules: BoundaryModuleContribution[];
  /**
   * Package-public symbols this boundary consumes over the destination's
   * package-public symbols. Null when the destination surface is unknown
   * (outgoing) or empty.
   */
  surfaceCoverage: number | null;
  symbols: {
    distinct: number;
    /** Distinct consumed symbols that are package-public; null when unknown. */
    packagePublic: number | null;
    references: number | null;
    /** references / distinct; null when either is unavailable or zero. */
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
  /** Distinct symbols across every boundary — a union, never a sum. */
  symbols: number;
}

interface BoundaryInteractionSummary {
  incoming: BoundaryInteractionTotals;
  outgoing: BoundaryInteractionTotals;
  /** Distinct (consumer, dependency) pairs routed through the target. */
  throughPaths: number;
}

export interface BoundaryInteractionReport {
  incoming: BoundaryInteraction[];
  outgoing: BoundaryInteraction[];
  summary: BoundaryInteractionSummary;
  target: string;
}

/**
 * Independent measurement families a pressure signal can draw on. Surface
 * (symbol counts) and consumption (consumer distribution) are separate
 * families even though both live on the surface report.
 */
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

/**
 * A place where several independent measurements converge. Fires only when
 * every configured gate matches, and only ever with at least two dimensions
 * of evidence. Descriptive: no score, no recommendation, no judgment of
 * whether the pressure is intentional — `intent` carries what is declared.
 */
export interface StructuralPressureSignal {
  /** Distinct dimensions present in `evidence`, in evidence order. */
  dimensions: PressureDimension[];
  evidence: PressureEvidence[];
  /** `${kind}:${scope.id}` */
  id: string;
  intent: ArchitecturalIntentProfile;
  kind: StructuralPressureKind;
  scope: { type: "package"; id: string };
}

/**
 * One boundary whose V5.2 interaction facts converge on substantial traffic.
 * `broad` — volume plus many distinct symbols; `concentrated` — traffic
 * landing mostly in one declaring module; `mixed` — both gate sets pass.
 */
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

/**
 * Coarse role of a file, by path convention only (`file-kind.ts`). Attached
 * to every module node so structure, history, and concepts split on one
 * classification; never a judgment.
 */
export type FileKind = "source" | "test" | "story" | "config" | "other";

/** `FileKind` under the name churn introduced it with. */
export type ChurnFileKind = FileKind;

/**
 * What a commit's eligible files are made of, by kind share alone: mostly
 * code, mostly config, or in between. Never inferred from the message.
 */
export type CommitComposition = "source-dominant" | "config-dominant" | "mixed";

/** The shared oversized rule, restated on each history-derived section. */
interface OversizedPolicy {
  /** Config-dominant commits spanning this many packages → mechanical sweep. */
  configSweepMinPackages: number;
  /** Code files (source, test, story) above this → oversized. */
  maxCodeFilesPerCommit: number;
}

/**
 * Evolutionary facts for one currently-tracked file. Counts and line churn
 * are limited to the history window; first/last changed and recency read
 * the full history, so an untouched file still reports when it last moved.
 * Line churn is additions + deletions; binary changes contribute commits
 * but no lines.
 */
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
    /** Author name as Git records it (after .mailmap); never an email. */
    primaryAuthor: string;
    /** Largest single author's share of this file's window commits. */
    primaryAuthorShare: number;
  };
  /**
   * Placement among every repository file of the same kind, 0–1: the share
   * of that population with a strictly lower value. Same window.
   */
  rank: {
    commitPercentile: number;
    lineChurnPercentile: number;
  };
}

/** Churn aggregated over one package or module. Commits are unique. */
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
  /** Over files with a recorded change; files never committed are absent. */
  daysSinceLastChange: MetricDistribution;
  linesChangedPerFile: MetricDistribution;
}

export interface ChurnSummary {
  additions: number;
  authors: number;
  byKind: Record<ChurnFileKind, ChurnKindTotals>;
  /** Unique commits touching any analyzed file inside the window. */
  commits: number;
  /** Files Git remembers under the target that no longer exist. */
  deletedFiles: number;
  deletions: number;
  filesAnalyzed: number;
  lastChangedAt?: string;
  linesChanged: number;
}

export interface ChurnHistoryInfo {
  /** Clock the window and recency were measured against. */
  analyzedAt: string;
  /**
   * Commits inside the window that changed any path under the root,
   * including paths since deleted; `repository.commits` counts only those
   * touching files that still exist.
   */
  commitsAnalyzed: number;
  /** False for shallow clones: history is truncated. */
  historyComplete: boolean;
  newestCommit?: string;
  oldestCommit?: string;
  /** Inclusive lower bound of the window, absent for full history. */
  since?: string;
  /** null = full history. */
  windowDays: number | null;
}

/**
 * Repository-wide context so a file's churn can later be placed against the
 * whole population. Same window, same exclusions, every tracked file.
 */
interface ChurnPopulation {
  commits: number;
  distributions: ChurnDistributions;
  filesAnalyzed: number;
}

/**
 * Git churn for the target: where change lands, how often, and how
 * recently. Raw counts only — no score, no hotspot, no coupling.
 */
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

/**
 * Descriptive facts a hotspot exhibits. `frequent-change` is present on
 * every hotspot; the rest name which structural or architectural condition
 * held. Never a verdict.
 */
export type HotspotSignal =
  | "frequent-change"
  | "branch-heavy"
  | "deep-control-flow"
  | "complexity-dense"
  | "architecturally-central";

interface HotspotEvolution {
  additions: number;
  /** Repository-relative, same-kind commit placement (see FileChurn.rank). */
  commitPercentile: number;
  commits: number;
  daysSinceLastChange?: number;
  deletions: number;
  lastChangedAt?: string;
  lineChurnPercentile: number;
  linesChanged: number;
}

/**
 * V4 function metrics folded to one file: totals across functions plus the
 * single worst function, so one difficult function is never averaged away.
 */
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
    /** Target-relative among eligible files, basis max control-flow decisions. */
    complexityPercentile: number;
  };
  signals: HotspotSignal[];
}

interface HotspotSummary {
  /** Files of an eligible kind with churn data (hotspot population). */
  eligibleSourceFiles: number;
  filesAboveCommitP90: number;
  filesAboveCommitP95: number;
  hotspotShare: number;
  hotspots: number;
}

/**
 * Where frequent change intersects structural complexity. Composition over
 * churn and local complexity; gravity only decorates. No score, no
 * opportunity.
 */
export type HotspotReport =
  | {
      available: true;
      target: string;
      /** Same window as churn, restated so the view is self-describing. */
      windowDays: number | null;
      summary: HotspotSummary;
      files: FileHotspot[];
    }
  | {
      available: false;
      reason: "git-unavailable" | "not-git-repository" | "not-collected";
    };

/**
 * What the current static graph says about a pair, by direct module edge
 * only. `left-to-right` means left imports right. `none` means no direct
 * edge either way — an import routed through a package barrel (`../index`,
 * `@scope/pkg`) lands on the barrel and reads as `none` here. `unmeasured`
 * means at least one side is not a graph module (non-TS files, tooling
 * config, declaration files), so "no edge" cannot be claimed.
 */
export type StaticRelation =
  | "left-to-right"
  | "right-to-left"
  | "bidirectional"
  | "none"
  | "unmeasured";

/**
 * Two nodes that repeatedly changed in the same commits. `left` < `right`
 * lexically, so each unordered pair has one record. Commit counts are over
 * the coupling-eligible commits (inside the window, not oversized), so
 * `coChangeCommits ≤ min(leftCommits, rightCommits)` always holds; they can
 * be lower than V6.0 churn counts, which include oversized commits.
 */
export interface ChangeCouplingPair {
  coChangeCommits: number;
  /** coChangeCommits / (leftCommits + rightCommits − coChangeCommits). */
  jaccard: number;
  lastCoChangedAt?: string;
  left: string;
  leftCommits: number;
  /** coChangeCommits / leftCommits: how often left's change included right. */
  leftConditional: number;
  right: string;
  rightCommits: number;
  /** coChangeCommits / rightCommits: how often right's change included left. */
  rightConditional: number;
  /**
   * Reachability in either direction. `direct` restates the relation;
   * `indirect` means a path exists (typically through a barrel) although no
   * direct edge does; `none` means the graph offers no explanation.
   */
  staticPath: StaticPathRelation;
  /** Direct edge between the two, as V6.2 measured it. */
  staticRelation: StaticRelation;
}

export type StaticPathRelation = "direct" | "indirect" | "none" | "unmeasured";

/**
 * Which kinds of file a pair joins. `story-related` whenever either side
 * is a story; `mixed` for config with source or test. Lets consumers keep
 * test companions apart from parallel implementations without touching
 * the coupling facts.
 */
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

/** Strong coupling partners of one target file; only files with partners appear. */
export interface FileCouplingSummary {
  file: string;
  partners: number;
  strongest: {
    file: string;
    /** This file's conditional toward the partner. */
    conditional: number;
    jaccard: number;
  };
}

interface ChangeCouplingHistory {
  /**
   * Window commits with ≥ 1 eligible current file that are not oversized.
   * Single-file commits generate no pairs but count toward that file's
   * commit total, so conditionals reflect changes made alone.
   */
  commitsConsidered: number;
  /** Window commits dropped by the oversized rule. */
  commitsExcluded: number;
  /** Repository-wide unordered file pairs seen in considered commits. */
  observedFilePairs: number;
  oversized: OversizedPolicy;
  /** Same window as churn. */
  windowDays: number | null;
}

interface ChangeCouplingSummary {
  crossPackagePairs: number;
  filePairs: number;
  /** Strong file pairs whose static relation is `none` (both sides measured). */
  filePairsWithoutStaticEdge: number;
  /** Strong file pairs the graph cannot explain even indirectly. */
  filePairsWithoutStaticPath: number;
  packagePairs: number;
  packagePairsWithoutStaticEdge: number;
  samePackagePairs: number;
}

/**
 * Change coupling: which files and packages repeatedly move together
 * through history, and whether the static graph explains it. Pairs touch
 * the target on at least one side. Evidence only — no score, no cluster,
 * no recommendation.
 */
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

/**
 * Radius of one commit measured over the whole repository, listed because
 * it touched the target. Files are current, eligible-kind files after
 * rename resolution; packages are their owners; boundaries are directed
 * static package edges with both endpoints touched.
 */
export interface CommitRadius {
  /** Over the counted files; null when every counted change was binary. */
  additions: number | null;
  composition: CommitComposition;
  deletions: number | null;
  files: number;
  filesByKind: Record<ChurnFileKind, number>;
  hash: string;
  linesChanged: number | null;
  packageBoundariesCrossed: number;
  packageSet: string[];
  /** Owning packages, `<root>` excluded. */
  packages: number;
  sourceFiles: number;
  targetFileShare: number;
  targetFiles: number;
  /** 1 when the target package is among the owners, else 0 (directory targets). */
  targetPackages: number;
  timestamp: string;
}

export interface PackageCombination {
  commits: number;
  packages: string[];
}

interface ChangeRadiusHistory {
  commitsEligible: number;
  /** Observed commits failing the oversized rule; absent from distributions. */
  commitsExcluded: number;
  /** Window commits touching the target with ≥ 1 eligible file. */
  commitsObserved: number;
  /** Shared with change coupling. */
  oversized: OversizedPolicy;
  windowDays: number | null;
}

interface ChangeRadiusSummary {
  boundaries: MetricDistribution;
  /** Commits crossing ≥ 1 static package edge. */
  boundaryCrossingCommits: number;
  boundaryCrossingRate: number;
  commits: number;
  crossPackageCommits: number;
  /** crossPackageCommits / commits. */
  crossPackageRate: number;
  files: MetricDistribution;
  /** Most frequent multi-package sets touched together; shapes, not strength. */
  packageCombinations: PackageCombination[];
  packages: MetricDistribution;
  singlePackageCommits: number;
  sourceFiles: MetricDistribution;
}

/**
 * How wide a change to the target typically is. Raw distributions and
 * per-commit records only — no radius label, no score.
 */
export type ChangeRadiusReport =
  | {
      available: true;
      target: string;
      history: ChangeRadiusHistory;
      summary: ChangeRadiusSummary;
      /** Eligible commits, widest first. */
      commits: CommitRadius[];
    }
  | {
      available: false;
      reason: "git-unavailable" | "not-git-repository" | "not-collected";
    };

type EvolutionaryDimension = "churn" | "hotspot" | "coupling" | "radius";

/**
 * One historical measurement read from a V6 section. `subject` names the
 * file, package, or pair the value belongs to when the metric is not
 * target-wide.
 */
export interface EvolutionaryEvidence {
  dimension: EvolutionaryDimension;
  metric: string;
  subject?: string;
  value: number | string | boolean;
}

interface EvolutionarySupport {
  /** Change-radius commits inside the size limit; the support gate's basis. */
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

/**
 * A V5.3 pressure signal whose shape is also visible in development history.
 * Static evidence is the V5.3 signal's own evidence; evolutionary evidence
 * is read from churn, hotspots, coupling, and radius. No score.
 */
export interface EvolutionaryPressureSignal {
  evolutionaryEvidence: EvolutionaryEvidence[];
  intent: ArchitecturalIntentProfile;
  kind: EvolutionaryPressureKind;
  staticEvidence: PressureEvidence[];
  staticSignal: StructuralPressureKind;
  support: { commits: number };
}

/**
 * A V5.3 signal history does not currently reinforce. `static-only` means
 * support was adequate and the checked evidence fell short — not that the
 * pressure is disproven. `insufficient-history` means too few commits to
 * interpret either way.
 */
export interface StaticPressureSupport {
  /** The historical values that were checked. */
  evolutionaryEvidence: EvolutionaryEvidence[];
  staticSignal: StructuralPressureKind;
  status: "static-only" | "insufficient-history";
}

export type ArchitecturalTensionKind =
  | "static-leaf-temporal-coupling"
  | "static-pressure-low-evolution"
  | "temporal-coupling-without-static-path";

/** Where the static and historical descriptions disagree. Descriptive only. */
export interface ArchitecturalTension {
  evidence: {
    static: PressureEvidence[];
    evolutionary: EvolutionaryEvidence[];
  };
  kind: ArchitecturalTensionKind;
  summary: string;
  support: { commits: number };
}

/**
 * A source file with very high module fan-in and very high commit
 * frequency, regardless of executable complexity. Evidence for structural
 * pressure; never a V6.1 hotspot by itself. `role` says whether that
 * gravity is a barrel's or an internal module's.
 */
export interface HotStructuralHub {
  commitPercentile: number;
  commits: number;
  fanIn: number;
  fanOut: number;
  file: string;
  functions: number;
  role?: ModuleRole["kind"];
}

/**
 * Cross-package spread split by whether it followed a current static edge.
 * Edge-following spread is `boundaryCrossingRate` itself; only the edge-less
 * remainder is derived here.
 */
interface EvolutionarySpread {
  boundaryCrossingRate: number;
  crossPackageRate: number;
  /** Multi-package commits crossing no current static package edge. */
  edgeLessSpreadCommits: number;
  edgeLessSpreadRate: number;
}

/**
 * Static × evolutionary composition: which V5.3 pressures history
 * reinforces, which stay static-only, and where the two descriptions
 * disagree. Pure composition of existing sections — no Git reparse, no
 * score, no recommendation.
 */
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

/** Explicit TypeScript relationships that attach a symbol to a concept seed. */
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

/**
 * A named type-like declaration in the target that may represent a concept.
 * Identity is the resolved declaration (the symbol inventory id); re-exports
 * and barrels resolve back to it, so one declaration is one seed.
 */
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

/** One structural occurrence attaching a symbol (or module-level code) to a seed. */
export interface ConceptEvidence {
  file: string;
  kind: "declaration" | ConceptRelationshipKind;
  line: number;
  package: string;
  /**
   * Nearest enclosing named top-level declaration of the occurrence, in the
   * symbol-inventory id convention. Absent for module-level code and for
   * anonymous default exports.
   */
  source?: { symbolId: string; name: string; kind: SymbolKind };
  /** Seed id. */
  target: string;
}

/** A named symbol structurally attached to a seed, rolled up from evidence. */
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
  /** Root-relative files holding the seed declaration or any evidence. */
  modules: string[];
  packageCount: number;
  /** Representations declared in the target that are package-public; outside-target symbols are not assessed. */
  packagePublicRepresentations: number;
  /** Packages holding the seed declaration or any evidence; `<root>` is a raw owner. */
  packages: string[];
  /** Evidence occurrences excluding the declaration itself; counts in-target uses too. */
  references: number;
}

/**
 * The explicit structural neighborhood of one seed. Families are never merged,
 * and the declaring package is not an ownership claim.
 */
export interface ConceptFamily {
  distribution: ConceptDistribution;
  /**
   * V7.1 distribution of this family; attached by
   * `analyzeConceptDistribution` and always present on a `SurfaceReport`.
   */
  distributionAnalysis?: ConceptDistributionAnalysis;
  evidence: ConceptEvidence[];
  relationships: Record<ConceptRelationshipKind, number>;
  representations: ConceptRepresentation[];
  seed: ConceptSeed;
}

interface ConceptInventorySummary {
  aliases: number;
  /** Families with evidence in more than one package. */
  crossPackageFamilies: number;
  /** Families with evidence in more than one module. */
  distributedFamilies: number;
  families: number;
  implementations: number;
  seeds: number;
}

/** Named concept seeds declared in the target and their explicit structural families. */
export interface ConceptInventoryReport {
  /** V7.1 shape counts; present once distribution has been attached. */
  distribution?: ConceptDistributionSummary;
  families: ConceptFamily[];
  summary: ConceptInventorySummary;
  target: string;
}

/**
 * Representation kinds a package holds: the seed itself plus the V7.0
 * representation relationships.
 */
export type ConceptRepresentationKind =
  | "seed"
  | ConceptRepresentationRelationship;

/**
 * Where a family's named representations live. A representation is one
 * distinct symbol (a symbol attached by two relationships counts once) plus
 * the seed declaration. `primaryShare` is the largest package's share of
 * `total`; ties resolve to the lexically first package.
 */
export interface RepresentationDistribution {
  implementationModules: number;
  /** Distinct packages / files holding an `implementation` representation. */
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

/**
 * Where a family's structural references occur. `total` is the V7.0
 * `distribution.references` count (every non-declaration occurrence, in
 * target and out, module-level code included). Shares are of `total`;
 * `primaryShare` is null when there are no references.
 */
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

/** Per relationship kind, which packages the occurrences fall in. */
export interface RelationshipDistribution {
  byKind: {
    relationship: ConceptRelationshipKind;
    total: number;
    packages: { package: string; count: number }[];
  }[];
}

/**
 * Breadth of the family across boundaries. `packageSpan` is the number of
 * distinct participating packages (declaration ∪ evidence) minus one — a
 * count of boundaries the family reaches across, not a graph path length.
 */
export interface BoundaryDistribution {
  moduleCount: number;
  packageSpan: number;
  referencePackages: string[];
  representationPackages: string[];
  seedPackage: string;
}

/**
 * One package's participation in a family, for matrix-style consumers.
 * `seed` says the declaration lives here — a fact, not ownership.
 */
export interface ConceptPackagePresence {
  implementations: number;
  package: string;
  references: number;
  relationshipKinds: ConceptRelationshipKind[];
  representations: number;
  seed: boolean;
}

/**
 * Descriptive distribution shapes. `local` and `cross-package` are
 * exclusive and one always applies; the rest are additive and gated by
 * `conceptDistribution` policy. Never a judgment.
 */
export type ConceptDistributionShape =
  | "local"
  | "cross-package"
  | "implementation-split"
  | "reference-distributed"
  | "representation-concentrated";

/**
 * Two representation files of the same family that V6.2 already found
 * strongly coupled. Pairs are file-level; each side lists the family
 * representations declared in that file. Only pairs the coupling report
 * holds appear, and that report keeps pairs touching the target on at
 * least one side, so two out-of-target members never pair here.
 */
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

/**
 * V6 history annotating known members. History never adds a member: a
 * strong pair with one side outside the family is not listed.
 */
export interface TemporalConceptContext {
  /** Representation names whose file is a V6.1 hotspot; hotspots are target-scoped. */
  hotspotRepresentations: string[];
  /** Representation files inside the target that have churn data. */
  representedFilesWithChurn: number;
  strongMemberCouplings: TemporalMemberCoupling[];
}

/** V7.1: where one V7.0 family is distributed. `seed` points back at the family. */
export interface ConceptDistributionAnalysis {
  boundaries: BoundaryDistribution;
  packages: ConceptPackagePresence[];
  references: ReferenceDistribution;
  relationships: RelationshipDistribution;
  representations: RepresentationDistribution;
  seed: { id: string; name: string; kind: ConceptSeedKind; package: string };
  shapes: ConceptDistributionShape[];
  /** Absent when Git history is unavailable. */
  temporal?: TemporalConceptContext;
}

interface ConceptDistributionSummary {
  crossPackage: number;
  families: number;
  implementationSplit: number;
  local: number;
  referenceDistributed: number;
  representationConcentrated: number;
  /** Families with at least one strong coupling between two member files. */
  temporallyCoupled: number;
}

/** Distribution of every V7.0 family, in inventory order. */
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

/** One raw, explainable fact behind an overlap candidate. */
export interface ConceptOverlapEvidence {
  dimension: ConceptOverlapDimension;
  kind: ConceptOverlapEvidenceKind;
  value: number | string | boolean | string[];
}

/**
 * A type-like declaration anywhere in the workspace. `inTarget` says it is
 * a V7.0 seed with a family; foreign declarations have no family, so usage
 * and distribution evidence exist only between two in-target identities.
 */
export interface ConceptIdentity {
  file: string;
  id: string;
  inTarget: boolean;
  kind: ConceptSeedKind;
  name: string;
  package: string;
}

interface ConceptShapeProperty {
  /** Function-typed (a method or callback); a shape of only these is behavioral, not data. */
  callable: boolean;
  name: string;
  optional: boolean;
  readonly: boolean;
  /** Checker-printed property type; equality is the first compatibility test. */
  typeFingerprint: string;
}

/** Normalized property signature of an object-like declaration. */
export interface ConceptShape {
  properties: ConceptShapeProperty[];
}

export interface ConceptNameAffinity {
  /** shared / union over non-generic tokens. */
  jaccard: number;
  /** Shared tokens after generic-token removal, lowercase. */
  sharedTokens: string[];
}

/** Property-name overlap between two object-like shapes. */
export interface ConceptPropertyOverlap {
  /**
   * Shared names both sides inherit from Error (`name`, `message`, …), when
   * both derive from it. Kept in `shared` and the ratios; excluded from
   * gating and near-equivalence.
   */
  baseShared: string[];
  /** Shared properties whose types print the same or are mutually assignable. */
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

/** A function whose signature takes one concept and returns the other. */
export interface ConceptConversion {
  file: string;
  from: string;
  function: string;
  to: string;
}

/** Symbols and modules that reference both concepts (both in target). */
export interface ConceptOverlapUsageContext {
  sharedConsumers: string[];
  sharedModules: string[];
}

/** V7.1 package overlap of two in-target families. */
export interface ConceptOverlapDistributionContext {
  packageJaccard: number;
  sharedModules: string[];
  sharedPackages: string[];
}

/** Strong V6 coupling between the two declaration files. Annotation only. */
export interface ConceptOverlapTemporalContext {
  coChangeCommits: number;
  context: CouplingContext;
  jaccard: number;
  leftConditional: number;
  rightConditional: number;
  staticPath: StaticPathRelation;
}

/**
 * Descriptive overlap shapes; several may apply. None claims duplication,
 * equivalence, or which side is canonical.
 */
export type ConceptOverlapShape =
  | "near-equivalent"
  | "projection-like"
  | "conversion-pair"
  | "structurally-overlapping";

/**
 * Two distinct concept identities whose deterministic evidence says they
 * may represent one underlying idea. Both families stay separate.
 */
export interface ConceptOverlapCandidate {
  /** Absent when either side is not object-like. */
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

/** How many pairs each generator proposed, and how many were evaluated. */
interface ConceptOverlapGeneration {
  candidates: number;
  indexedDeclarations: number;
  pairsCompared: number;
  pairsGenerated: {
    name: number;
    property: number;
    conversion: number;
    temporal: number;
    /** Distinct pairs after union and family-member exclusion. */
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

/** Overlap candidates between target seeds and any workspace declaration. */
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

/**
 * Centers a package may hold for one concept. A concept may have different
 * centers for different responsibilities; no role is "the owner".
 */
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

/**
 * Executable symbols explicitly attached to the concept, by package.
 * `contract` counts functions and members whose own signature names the
 * seed (parameter, return, or construction); `implementation` counts every
 * bodied member of a class that implements the seed. Interface members are
 * declarations, never behavior.
 */
export interface ConceptBehaviorDistribution {
  byPackage: {
    package: string;
    functions: number;
    methods: number;
    constructors: number;
    contract: number;
    implementation: number;
    /** (contract + implementation) / total. */
    share: number;
    /** The same counts split by the kind of file holding the behavior. */
    kinds: Partial<
      Record<ChurnFileKind, { contract: number; implementation: number }>
    >;
  }[];
  contractTotal: number;
  /** The individual symbols behind the package rows; sums match. */
  participants: ConceptBehaviorParticipant[];
  total: number;
}

/**
 * One executable symbol explicitly attached to the concept. Members are
 * named `Class.member`; a constructor is `Class.constructor`. `kind` is
 * the declaring file's kind.
 */
export interface ConceptBehaviorParticipant {
  file: string;
  kind: ChurnFileKind;
  /** Declaration line range, so evidence occurrences can be placed inside one member. Absent on converters V7.4 adds. */
  lines?: { start: number; end: number };
  member: "function" | "method" | "constructor";
  package: string;
  role: "contract" | "implementation";
  symbol: string;
}

/** Named representations one package holds, by the kind of file declaring them. */
export interface ConceptRepresentationKinds {
  kinds: Partial<Record<ChurnFileKind, number>>;
  package: string;
}

/**
 * One V6.2 strong pair between two representation files, seen from `file`'s
 * package. Support stays visible: commits, both conditionals, Jaccard.
 */
export interface ConceptEvolutionCoupling {
  /** Either file is an aggregator (target roles only): a mechanical companion, not conceptual coupling. */
  aggregatorMediated: boolean;
  coChangeCommits: number;
  /** coChangeCommits / this file's commits. */
  conditional: number;
  context: CouplingContext;
  file: string;
  jaccard: number;
  /** coChangeCommits / the partner's commits. */
  partnerConditional: number;
  partnerFile: string;
  partnerPackage: string;
  staticPath: StaticPathRelation;
}

/**
 * V6 history over this family's representation files, by package. Churn
 * and hotspots are target-scoped, so only coupling pairs and their
 * per-file commits can support a foreign package.
 */
export interface ConceptEvolutionEvidence {
  changedRepresentationFiles: number;
  commits: number;
  couplings: ConceptEvolutionCoupling[];
  hotspotRepresentations: number;
  /** Representation files that are V6.1 hotspots, with the rank behind the label. */
  hotspots: { file: string; commits: number; commitPercentile: number }[];
  package: string;
  /** Every strong pair touching this package's representation files. */
  strongCouplingPairs: number;
  /** changedRepresentationFiles + hotspotRepresentations + supportingCouplingPairs. */
  support: number;
  /** Pairs whose context is in `evolutionCenter.couplingContexts`. */
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

/** Each role's package where the gate was met; roles may disagree. */
export interface ConceptOwnershipCenter {
  behavior?: string;
  evolution?: string;
  implementations: string[];
  representation?: string;
  semantic?: string;
  usage?: string;
}

/** Descriptive convergence of the centers. Not a quality judgment. */
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
  /** Share or support that met the gate, as the gate measured it. */
  value: number;
}

/**
 * `no-implementation-evidence` says only that no `implements` clause names
 * the seed: object-literal and factory conformance are not analyzed, so it
 * never proves the absence of implementations.
 */
type OwnershipCautionKind =
  | "sparse-history"
  | "anchored-seed"
  | "no-implementation-evidence";

export interface OwnershipCaution {
  detail: string;
  kind: OwnershipCautionKind;
}

/**
 * A V7.2 overlap partner and where its converters live. A representation
 * boundary is a partner in another package with converters there — often a
 * healthy domain/persistence split, never a tension by itself.
 */
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
  /** Absent when Git history is unavailable. */
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

/** Where each V7.0 family's centers sit, in inventory order. */
export interface ConceptOwnershipReport {
  concepts: ConceptOwnershipAnalysis[];
  summary: ConceptOwnershipSummary;
  target: string;
}

/**
 * V7.4 behavior roles. A converter is a contract participant (its
 * signature names the concept) that V7.2 also lists as a conversion, so
 * `conversion` never adds a participant; it tags one.
 */
export type BehaviorRole = "contract" | "implementation" | "conversion";

/** One package's share of a concept's behavior. No ownership reading. */
export interface ConceptBehaviorPackage {
  behaviors: number;
  contractBehaviors: number;
  conversionBehaviors: number;
  implementationBehaviors: number;
  /** Modules (root-relative files) holding behavior here. */
  modules: number;
  package: string;
  sourceBehaviors: number;
  sourceModules: number;
  storyBehaviors: number;
  testBehaviors: number;
}

/**
 * One module holding concept behavior. A module is a root-relative file,
 * the same granularity as `ConceptDistribution.modules` and the module
 * graph; there is no second one.
 */
export interface ConceptBehaviorModule {
  behaviors: number;
  contractBehaviors: number;
  conversionBehaviors: number;
  implementationBehaviors: number;
  kind: ChurnFileKind;
  module: string;
  package: string;
  /** Target module roles only; foreign modules are not classified. */
  role?: ModuleRole["kind"];
}

/** Every behavioral participant of a concept, by file kind, package, and module. */
export interface ConceptBehaviorMap {
  byModule: ConceptBehaviorModule[];
  byPackage: ConceptBehaviorPackage[];
  /** Config and unclassified files. */
  other: number;
  source: number;
  story: number;
  test: number;
  total: number;
}

/** How many modules and packages source behavior spans, and which package edges join them. */
export interface ConceptBehaviorSpan {
  /** Direct package-graph edges between two source behavior packages; `from` imports `to`. */
  boundaryEdges: { from: string; to: string }[];
  moduleCount: number;
  packageBoundaryCount: number;
  packageCount: number;
  sourceModuleCount: number;
  sourcePackageCount: number;
}

/**
 * Shortest static path between two behavioral nodes. `outward` follows
 * dependency edges from `from` toward `to` (`from` imports … imports
 * `to`); `inward` is the reverse. Both absent means neither reaches the
 * other: disconnected. No undirected distance is invented.
 */
export interface ConceptDistance {
  from: string;
  inward?: number;
  outward?: number;
  to: string;
  /** A known aggregator sits strictly inside a shortest path (module level; target roles only). */
  viaAggregator?: boolean;
}

/**
 * Travel from the concept's semantic center over the static graph. Module
 * distances start at the seed's declaring module, so two sibling modules
 * that both hang off the seed are each one step away, not disconnected
 * from each other; package pairs are measured pairwise because two
 * implementation packages that never reach each other is the fact §72
 * wants kept.
 */
export interface ConceptTraversalContext {
  /** Origin package to every other source behavior package. */
  centerDistances: ConceptDistance[];
  /** Source behavior modules with no static path to or from the seed module. */
  disconnectedModules: number;
  disconnectedPackagePairs: number;
  maxModuleDistance: number | null;
  maxPackageDistance: number | null;
  /** Origin module to every other source behavior module. */
  moduleDistances: ConceptDistance[];
  /** The semantic center: seed package and declaring module. */
  origin: { package: string; module: string };
  /** Every pair of source behavior packages, lexical order. */
  packageDistances: ConceptDistance[];
  participatingModules: string[];
  participatingPackages: string[];
}

/** Observed structural surface a change to the concept's behavior touches. Not a prediction. */
interface ConceptChangeSurface {
  converterModules: number;
  /** Source behavior modules that are V6.1 hotspots (target-scoped). */
  hotspotModules: number;
  implementationModules: number;
  packages: number;
  sourceModules: number;
  /** Behavior modules in a strong V6.2 pair with another behavior module. */
  stronglyCoupledBehaviorModules: number;
}

/** V7.1 reference breadth beside the behavior map; never part of locality. */
interface ConceptReferenceHalo {
  modules: number;
  packages: number;
  references: number;
}

/** Largest package and module share of source behavior; not ownership. */
interface ConceptBehaviorConcentration {
  primaryModule?: string;
  primaryModuleShare: number | null;
  primaryPackage?: string;
  primaryPackageShare: number | null;
}

/** Strong V6.2 pair between two behavior modules of the concept. */
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

/** A behavior module's strong partner outside the concept's behavior. Never joins the map. */
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

/**
 * Descriptive locality of source behavior; one primary shape always
 * applies. Not a quality label: `cross-package-localized` is often a
 * clean domain/persistence split, and `behavior-light` a healthy
 * semantic type.
 */
export type BehavioralLocalityShape =
  | "local"
  | "single-package-distributed"
  | "cross-package-localized"
  | "cross-package-distributed"
  | "behavior-light"
  | "insufficient-evidence";

/** Additive shape: implementation behavior in several packages. */
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

/** V7.4: how far understanding or changing one concept's behavior travels. */
export interface ConceptBehavioralLocality {
  /** The seed package is anchored; context only. */
  anchored: boolean;
  behavior: ConceptBehaviorMap;
  cautions: BehavioralLocalityCaution[];
  changeSurface: ConceptChangeSurface;
  concentration: ConceptBehaviorConcentration;
  concept: ConceptIdentity;
  /** V7.1 primary representation and reference packages, beside the behavior primary. */
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
  /** Absent when Git history is unavailable. */
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

/** Behavioral locality of every V7.0 family, in inventory order. */
export interface ConceptBehavioralLocalityReport {
  concepts: ConceptBehavioralLocality[];
  summary: ConceptBehavioralLocalitySummary;
  target: string;
}

/** Independent evidence families a V8.0 re-centering tension draws on. */
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

/**
 * Deterministic disagreement between the concept's placement and one
 * observed center. Descriptions, never recommendations: no tension names
 * a destination.
 */
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

/** V8.0 evaluates concept families only. */
interface RecenteringSubject {
  concept: ConceptIdentity;
  kind: "concept-family";
}

/** Where the concept sits today, read from V7.3 centers. Not recomputed. */
export interface CurrentArchitecturalPlacement {
  /** Packages holding source behavior. */
  behaviorPackages: string[];
  evolutionCenter?: string;
  implementationCenters: string[];
  representationCenter?: string;
  seedPackage: string;
  semanticCenter?: string;
  usageCenter?: string;
}

/**
 * What one V7.3 participant does with the concept, read from the evidence
 * inside its own line range. Precedence: implementation, conversion,
 * return, construction, parameter-consumer. A function that constructs the
 * concept and returns it is a factory and reads as `return`; constructing
 * without returning (throwing, storing) is `construction`. Only
 * implementation, conversion, and return count as strong: accepting or
 * constructing the concept is use, not owned behavior.
 */
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
  /** Source participants; test and story participants are excluded. */
  source: number;
  strong: number;
  /** Source modules holding strong behavior. */
  strongModules: number;
  /** Share of strong behavior in the two largest strong modules. */
  topTwoStrongModuleShare: number | null;
  weak: number;
}

/** The V7.4 facts the gates read, copied beside the candidate. */
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
  /** Share of source behavior in the two largest source modules. */
  topTwoModuleShare: number | null;
}

/** V6 history beside the candidate; absent when Git history is unavailable. */
export interface RecenteringHistoricalContext {
  /** Strong source-source pairs between behavior modules of different packages. */
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

/**
 * A V7.2 overlap partner with converters, beside the candidate. A strong
 * representation boundary often explains a semantic/representation split
 * and reduces the need for re-centering rather than adding to it.
 */
export interface RepresentationBoundaryContext {
  converterPackages: string[];
  explicitBidirectionalConversion: boolean;
  overlappingConcept?: ConceptIdentity;
  structuralOverlap?: number;
}

export interface RecenteringIntentContext {
  /** Anchored packages among the observed centers and behavior packages. */
  anchoredObservedPackages: string[];
  anchorReason?: string;
  representationBoundaries: RepresentationBoundaryContext[];
  seedAnchored: boolean;
}

/** Descriptive candidate shapes; several may apply. Evidence descriptions, not recommendations. */
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

/**
 * V8.0: enough deterministic disagreement between placement and observed
 * centers that considering an alternative arrangement is justified. No
 * destination, no delta, no ranking; `protected` keeps the evidence while
 * saying the seed package's anchor constrains movement.
 */
export interface RecenteringCandidate {
  behavior: RecenteringBehaviorProfile;
  cautions: RecenteringCaution[];
  currentPlacement: CurrentArchitecturalPlacement;
  /** Distinct dimensions of the tensions; one tension contributes one. */
  dimensions: RecenteringDimension[];
  evidence: RecenteringEvidence[];
  history?: RecenteringHistoricalContext;
  id: string;
  intent: RecenteringIntentContext;
  locality: RecenteringLocalityContext;
  shapes: RecenteringCandidateShape[];
  status: RecenteringStatus;
  /** Tensions that alone satisfy the strong structural condition. */
  strongTensions: RecenteringTension[];
  subject: RecenteringSubject;
  tensions: RecenteringTension[];
}

export interface RecenteringCandidateSummary {
  byShape: Record<RecenteringCandidateShape, number>;
  byTension: Record<RecenteringTension, number>;
  candidates: number;
  evaluated: number;
  /** Emitted with at least one tension but below the eligibility gate. */
  insufficientEvidence: number;
  protected: number;
}

/**
 * Families with at least one tension, ordered by strong tensions,
 * dimensions, strong behavior, historical support, then name. Families
 * without a tension are evaluated but not emitted.
 */
export interface RecenteringCandidateReport {
  candidates: RecenteringCandidate[];
  /** V8.3: structural consequences of every scenario against the current arrangement. */
  impacts: ScenarioImpactReport;
  /** V8.1: declared home against observed center of gravity. */
  miscentered: MiscenteredConceptReport;
  /** V8.4: per-finding comparison of those consequences; dispositions, never recommendations. */
  reviews: ArchitecturalReviewReport;
  /** V8.2: explicit current arrangement plus evidence-backed alternatives per finding. */
  scenarios: RecenteringScenarioReport;
  summary: RecenteringCandidateSummary;
  target: string;
}

/**
 * V8.1 evidence families. Each reads one existing analysis; none is
 * recomputed here. Using a concept (consumer and dependency gravity) is
 * weaker evidence than producing or governing it (behavioral locality,
 * symbol distribution).
 */
export type MiscenteringEvidenceKind =
  | "consumer-gravity"
  | "dependency-gravity"
  | "symbol-distribution"
  | "behavioral-locality"
  | "boundary-crossing"
  | "concept-distribution"
  | "ownership";

/**
 * Families with a per-package share that composes into gravity. Dependency
 * gravity is evidence only: import sites into the seed module are measured
 * across package boundaries, so the declared home never has a share there.
 */
export type MiscenteringGravityFamily =
  | "behavioral-locality"
  | "symbol-distribution"
  | "consumer-gravity";

/**
 * One mismatch class. `external-gravity`: one other package clearly
 * dominates. `boundary-drift`: the declared home keeps the symbol center
 * while most governing behavior sits outside it. `split-gravity`: no
 * package dominates. Precedence in that order; one signal per concept.
 */
export type MiscenteringSignal =
  | "external-gravity"
  | "split-gravity"
  | "boundary-drift";

export interface MiscenteringEvidence {
  kind: MiscenteringEvidenceKind;
  metric: string;
  package?: string;
  source: RecenteringEvidenceSource;
  /** Points away from the declared home toward the signal; otherwise context. */
  supports: boolean;
  value: number | string | string[];
}

/** Where the code says the concept lives: the seed declaration. */
export interface DeclaredHome {
  anchored: boolean;
  anchorReason?: string;
  module: string;
  package: string;
}

export interface ObservedCenter {
  anchored: boolean;
  /** Weighted composite of the family shares below, in [0, 1]. */
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

/**
 * V8.1: the declared home and the observed center of gravity disagree
 * across at least two evidence families. A signal, never a verdict or a
 * destination. `evidenceConfidence` is how well the deterministic evidence
 * matches the signal's pattern, not the probability the concept is
 * misplaced.
 */
export interface MiscenteredConceptFinding {
  /** The declared home is anchored. */
  anchored: boolean;
  cautions: MiscenteringCaution[];
  concept: ConceptIdentity;
  declaredHome: DeclaredHome;
  evidence: MiscenteringEvidence[];
  evidenceConfidence: number;
  /** Families that had data, with the weights the composite used. */
  gravityFamilies: MiscenteringGravityFamily[];
  id: string;
  /** Strongest other center's gravity minus the declared home's. Ranking context, not proof. */
  mismatch: number;
  /** Every package with gravity, strongest first. */
  observedCenters: ObservedCenter[];
  signal: MiscenteringSignal;
  summary: string;
  supportingFamilies: MiscenteringEvidenceKind[];
  weights: Partial<Record<MiscenteringGravityFamily, number>>;
}

/**
 * Why a concept produced no finding. `behavior-light`: too little
 * governing behavior to read gravity (shared types, identifiers).
 * `usage-only`: another package leads on consumption alone.
 * `unclear`: a mismatch below every gate.
 */
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

/** Findings ordered by evidence confidence, mismatch, then name. */
export interface MiscenteredConceptReport {
  /** Every family's outcome, in inventory order, so a missing finding is explained. */
  assessed: { concept: ConceptIdentity; outcome: MiscenteringOutcome }[];
  findings: MiscenteredConceptFinding[];
  summary: MiscenteredConceptSummary;
  target: string;
}

/**
 * V8.2 responsibility vocabulary. Each is assigned to a package only where
 * deterministic evidence places it there; a responsibility without evidence
 * is omitted from the placement, never guessed.
 */
export type ScenarioResponsibility =
  | "semantic-contract"
  | "domain-behavior"
  | "implementation"
  | "persistence"
  | "representation"
  | "conversion"
  | "integration"
  | "consumption";

/**
 * Where a concept's responsibilities sit in one arrangement. Current and
 * proposed share this shape so a later version can diff them without
 * reading narrative. Packages within a responsibility are sorted.
 */
export interface ScenarioPlacement {
  responsibilities: {
    responsibility: ScenarioResponsibility;
    packages: string[];
  }[];
  semanticCenter: string;
}

/**
 * Architectural hypotheses. `preserve-current` is the explicit baseline
 * every finding carries; the others move one responsibility at a time.
 * The order here is the precedence used for dedup and truncation.
 */
export type RecenteringScenarioKind =
  | "preserve-current"
  | "rehome-semantic-center"
  | "rehome-behavior"
  | "consolidate-behavior"
  | "formalize-representation-boundary"
  | "split-responsibility";

/** Why a package is eligible as a center. Shares and counts, not a score. */
export interface ScenarioCandidateCenter {
  anchored: boolean;
  package: string;
  reasons: {
    semantic?: boolean;
    /** Governing-behavior share. */
    behavior?: number;
    /** Representation share. */
    representation?: number;
    /** Implementations (V7.3 implementation center or `implements` participants). */
    implementation?: number;
    evolution?: boolean;
    /** Converters declared here. */
    conversion?: number;
    /** Strongly related V7.2 families declared or converted here. */
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

/**
 * Completeness of the deterministic evidence behind a scenario, not the
 * probability the arrangement is right. `strong`: three or more distinct
 * rationale kinds; `moderate`: two; `weak`: fewer, or any
 * `structural-conformance-unknown` constraint.
 */
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
  /** Anchored packages among the candidate centers. */
  anchoredCenters: string[];
  homeAnchored: boolean;
}

/**
 * One responsibility arrangement worth simulating. Architectural state,
 * never an operation sequence: no delta, no files, no imports, no ranking.
 * `blocked` keeps the evidence while saying an explicit constraint forbids
 * the arrangement; `constrained` means possible if something is preserved.
 */
export interface RecenteringScenario {
  /** Responsibilities whose packages differ between current and proposed. */
  affectedResponsibilities: ScenarioResponsibility[];
  anchorContext: ScenarioAnchorContext;
  cautions: ScenarioCaution[];
  confidence: ScenarioEvidenceConfidence;
  constraints: ScenarioConstraint[];
  current: ScenarioPlacement;
  findingId: string;
  /** `${findingId}::${kind}::${canonical proposed placement}`; stable across runs. */
  id: string;
  kind: RecenteringScenarioKind;
  preservedResponsibilities: ScenarioResponsibility[];
  proposed: ScenarioPlacement;
  rationale: RecenteringScenarioEvidence[];
  status: ScenarioStatus;
  subject: ConceptIdentity;
}

/** Generation bookkeeping per finding, for tuning. */
interface ScenarioGenerationDiagnostics {
  blocked: number;
  centersConsidered: number;
  deduplicated: number;
  /** Present when only the baseline was generated. */
  noAlternativeReason?: string;
  proposed: number;
  /** Dropped by `maxScenariosPerFinding`, in precedence order. */
  truncated: number;
}

export interface RecenteringScenarioFinding {
  candidateCenters: ScenarioCandidateCenter[];
  diagnostics: ScenarioGenerationDiagnostics;
  findingId: string;
  /** Kind precedence, then destination name. Never confidence. */
  scenarios: RecenteringScenario[];
  signal: MiscenteringSignal;
  subject: ConceptIdentity;
}

export interface RecenteringScenarioSummary {
  baselineOnly: number;
  blocked: number;
  blockedByAnchor: number;
  /** Proposed semantic center or consolidation target per non-baseline scenario. */
  byDestination: Record<string, number>;
  byKind: Record<RecenteringScenarioKind, number>;
  /** Findings by number of candidate centers. */
  candidateCenters: { one: number; two: number; threePlus: number };
  constrained: number;
  constrainedByIncompleteEvidence: number;
  findings: number;
  findingsWithAlternatives: number;
  plausible: number;
  scenarios: number;
  scenariosPerFinding: { max: number; p50: number; p90: number };
  /** V8.1 outcomes that generated nothing. */
  skipped: Record<Exclude<MiscenteringOutcome, "finding">, number>;
}

/**
 * V8.2: for each V8.1 finding, the explicit current arrangement plus a
 * small set of evidence-backed alternatives. No scenario is preferred,
 * recommended, ranked, or scored; consequences are a later version.
 */
export interface RecenteringScenarioReport {
  findings: RecenteringScenarioFinding[];
  summary: RecenteringScenarioSummary;
  target: string;
}

/**
 * V8.3 certainty of one predicted consequence. `certain`: the scenario's
 * placement states it. `conditional`: follows from module-level facts if
 * the concept's modules move whole and the edge carries nothing else at
 * symbol level. `unknown`: direction or value is not derivable.
 */
export type ImpactCertainty = "certain" | "conditional" | "unknown";

/** Predicted numbers only where they are derivable; otherwise null with the certainty saying why. */
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

/**
 * A package edge the concept touches, concept-scoped. `conceptImportSites`
 * is what the concept's own modules contribute; the boundary is exclusive
 * when every import site and every imported module belongs to the concept,
 * at module granularity. Foreign-to-foreign edges have no interaction data
 * and are `measured: false`.
 */
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

/**
 * One package edge under a scenario. `eliminated` needs the concept's
 * interaction to end and the edge to carry nothing else; an edge whose
 * concept interaction ends but that other modules still cross is
 * `reduced` with `conceptInteractionEnds`.
 */
export interface ScenarioBoundaryState {
  certainty: ImpactCertainty;
  conceptImportSites: number | null;
  /** Concept import sites the vacating modules carried; null on unmeasured edges. */
  conceptImportSitesRemoved: number | null;
  conceptInteractionEnds: boolean;
  edge: string;
  exclusive: boolean;
  from: string;
  importSites: number | null;
  outcome: ScenarioBoundaryOutcome;
  /** Concept modules that keep using the edge. */
  remainingModules: string[];
  to: string;
  /** Concept modules whose participation across this edge the scenario removes. */
  vacatedModules: string[];
}

export interface BoundaryReduction {
  certainty: ImpactCertainty;
  conceptImportSitesRemoved: number;
  /** The concept no longer crosses the edge; unrelated traffic keeps it. */
  conceptInteractionEnds: boolean;
  edge: string;
  remainingModules: number;
}

/**
 * Concept-scoped, never package gravity: current edges are the concept's
 * behavior-package edges plus the packages importing the seed module;
 * fan-in and fan-out count those edges at the semantic center only.
 */
export interface DependencyImpact {
  added: ScenarioDependencyEdge[];
  currentEdges: ScenarioDependencyEdge[];
  packageFanInDelta: ScenarioMetricDelta;
  packageFanOutDelta: ScenarioMetricDelta;
  predictedEdges: ScenarioDependencyEdge[];
  preserved: ScenarioDependencyEdge[];
  removed: ScenarioDependencyEdge[];
  /** Edges whose fate the facts cannot settle: not measured, or reduced but not exclusive. */
  uncertain: ScenarioDependencyEdge[];
}

export interface BoundaryImpact {
  added: string[];
  /** Concept modules that import or are imported across measured edges. */
  conceptModulesDelta: ScenarioMetricDelta;
  current: ScenarioBoundaryState[];
  /** Edges with no remaining structural reason: concept interaction ends and nothing else crosses them. */
  eliminated: string[];
  /** Concept import sites across measured edges. */
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

/** Span and travel; `decrease` means fewer packages or edges, never a quality reading. */
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
  /** Parameter consumption and construction; never relocated. */
  weak: number;
}

export interface BehaviorImpact {
  certainty: ImpactCertainty;
  consumerBehaviorUnaffected: number;
  currentByPackage: ScenarioBehaviorPlacement[];
  governingBehaviorPreserved: number;
  governingBehaviorRelocated: number;
  /** Relocated governing behavior whose destination the scenario does not name. */
  governingBehaviorUnplaced: number;
  packagesAdded: string[];
  /** Packages whose governing behavior the scenario removes entirely. */
  packagesRemoved: string[];
  predictedByPackage: ScenarioBehaviorPlacement[];
}

export interface SurfaceImpact {
  /** Packages referencing the concept outside the home; never assumed to change. */
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
  /** Partner concepts whose boundary the scenario makes explicit. */
  representationBoundariesAdded: string[];
  representationBoundariesRemoved: string[];
  semanticRepresentationsCurrent: string[];
  semanticRepresentationsPredicted: string[];
}

export interface ImplementationImpact {
  currentCenters: string[];
  /** Two or more implementation centers today, and the scenario leaves them where they are. */
  parallelImplementationPreserved: boolean;
  predictedCenters: string[];
  preservedImplementations: string[];
  relocatedImplementationResponsibility: string[];
}

/**
 * Structural alignment with past co-change, not a churn forecast. A
 * co-located pair is one whose modules the scenario would place in one
 * package; the history that made them a pair stays what it was.
 */
export interface EvolutionImpact {
  couplingRelationshipsCoLocated: number;
  couplingRelationshipsPreserved: number;
  couplingRelationshipsStillCrossBoundary: number;
  /** Pairs with a relocated module whose destination the scenario does not name. */
  couplingRelationshipsUnknown: number;
  historicalEvidenceAlignment: "improves" | "unchanged" | "mixed" | "unknown";
  historicallyCoupledFilesAffected: number;
  hotspotBehaviorRelocated: number;
}

export interface IntentImpact {
  /** `package: responsibility` pairs an anchored package would gain or lose. */
  anchoredResponsibilitiesAdded: string[];
  anchoredResponsibilitiesRemoved: string[];
  anchorsPreserved: string[];
  anchorsViolated: string[];
  compatibility: "compatible" | "constrained" | "incompatible";
  publicBoundaryChanges: string[];
}

/** Independent dimensions; never folded into one number. */
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

/**
 * `simulated`: every dimension rests on measured facts or the scenario's
 * own placement. `partially-simulated`: a dimension that could change the
 * result is unmeasured (structural conformance, an edge without
 * interaction data). `blocked`: the V8.2 scenario is blocked; the vector
 * is still simulated as a counterfactual.
 */
export type ScenarioImpactStatus =
  | "simulated"
  | "partially-simulated"
  | "blocked";

/**
 * V8.3: what one V8.2 scenario would change relative to the current
 * arrangement. Vector-shaped, never scored, ranked, or recommended; no
 * file moves, import rewrites, or cost. `summary` restates the vector in
 * words with the same vocabulary.
 */
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
  /** Behavior package span decreases and increases; span, not quality. */
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

/** V8.4 review dimensions: the V8.3 vector's, plus its uncertainties read as evidence. */
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

/** One interpreted fact, always traceable to a V8.3 impact under `sourceScenarioId`. */
export interface ArchitecturalReviewEvidence {
  certainty: ImpactCertainty;
  detail: string;
  dimension: ArchitecturalReviewDimension;
  kind: string;
  sourceScenarioId: string;
}

/**
 * `baseline`: the preserve-current scenario; dominance of it is recorded
 * in the review's `dominated` list. `indistinguishable`: identical V8.3
 * vector to an earlier scenario. `insufficient-evidence`: partially
 * simulated, or differs from the baseline only through conditional or
 * unknown consequences.
 */
export type ReviewedScenarioStatus =
  | "baseline"
  | "viable"
  | "dominated"
  | "invalid"
  | "indistinguishable"
  | "insufficient-evidence";

/**
 * Completeness of the V8.3 simulation behind a scenario, never its merit.
 * `strong`: fully simulated and every predicted change is certain.
 * `partial`: fully simulated with conditional changes. `weak`: partially
 * simulated or blocked.
 */
export type ReviewEvidenceCompleteness = "strong" | "partial" | "weak";

/** Descriptive effects a scenario has; several may apply, none is a merit. */
export type ArchitecturalScenarioEffect =
  | "center-alignment"
  | "locality-contraction"
  | "boundary-reduction"
  | "dependency-reduction"
  | "responsibility-clarification"
  | "surface-relocation"
  | "representation-preservation"
  | "intent-conflict";

/**
 * Whether the scenario reduces structure with certainty, moves it, makes
 * responsibilities explicit, or leaves the vector as it is. `relocation`
 * is center alignment or surface relocation without a certain reduction.
 */
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
  /** Dimensions where this scenario reads better than the baseline; for the baseline, where it reads better than an alternative. */
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
  /** Weakest certainty among the facts the relation rests on. */
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

/**
 * Pareto comparison of two V8.3 vectors, no weights. Dominance needs
 * every graded dimension no worse, at least one strictly better on
 * certain evidence (policy), no unknown relation, and both scenarios
 * fully simulated. The uncertainty dimension is descriptive and never
 * grades.
 */
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
  /** Dimensions where the dominator is strictly better. */
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

/**
 * Review state of one finding, never an implementation recommendation.
 * `credible-alternative`: an alternative dominates the baseline and no
 * other dominator trades off against it. `multiple-tradeoffs`: viable
 * scenarios optimize different dimensions. `intent-blocked`: the only
 * structural alternatives are invalid under explicit intent.
 */
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
  /** Non-dominated, fully simulated, intent-compatible or constrained scenarios, the baseline included. */
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

/**
 * V8.4: per-finding architectural review over V8.2 scenarios and V8.3
 * impacts. Compositional; no rescan, no score, no plan. Findings are not
 * aggregated into repository patterns here.
 */
export interface ArchitecturalReviewReport {
  reviews: ArchitecturalScenarioReview[];
  summary: ArchitecturalReviewSummary;
  target: string;
}

export interface SurfaceReport {
  /** Present when the target matches a configured anchor definition. */
  anchor?: { target: string; reason?: string };
  /** Descriptive architectural role composed from the sections above. */
  architecturalProfile: ArchitecturalProfileReport;
  /** Traffic volume and concentration per package boundary. */
  boundaryInteractions: BoundaryInteractionReport;
  /** Files and packages that repeatedly change together, vs the static graph. */
  changeCoupling: ChangeCouplingReport;
  /** How many files, packages, and static boundaries a target commit moves. */
  changeRadius: ChangeRadiusReport;
  /** Git churn of the target's current files; unavailable outside Git. */
  churn: ChurnReport;
  /** How far each concept's behavior spans over the static graph and history. */
  conceptBehavioralLocality: ConceptBehavioralLocalityReport;
  /** Named concept seeds in the target and their explicit structural families. */
  conceptInventory: ConceptInventoryReport;
  /** Separate concepts whose deterministic evidence says they may overlap. */
  conceptOverlap: ConceptOverlapReport;
  /** Where each concept's semantic, implementation, usage, representation, and evolution centers sit. */
  conceptOwnership: ConceptOwnershipReport;
  dependencies: SurfaceDependencies;
  /** Dependency-pressure measurements over the workspace graph. */
  dependencyGravity: DependencyGravityReport;
  /** Which static pressures history reinforces, contradicts, or leaves unsupported. */
  evolutionaryPressure: EvolutionaryPressureReport;
  /** Frequent change meeting structural complexity; composed from churn + V4. */
  hotspots: HotspotReport;
  ineligibleOperations: IneligibleOperation[];
  /** Local structural complexity of every function in the boundary. */
  localComplexity: LocalComplexityReport;
  /** Per-operator lifecycle state: capabilities, candidates, plan statuses. */
  operators: OperatorSummary[];
  opportunities: ReductionOpportunity[];
  /**
   * One plan per internalize-symbol opportunity plus one per fold-package
   * opportunity; preserve-shared-boundary has no plans.
   */
  plans: ReductionPlan[];
  /** `ANALYSIS_POLICY_VERSION` the report was produced under; workspace ingestion keeps it per source. */
  policyVersion: number;
  /** Concepts whose observed centers disagree with their placement enough to examine. */
  recenteringCandidates: RecenteringCandidateReport;
  schemaVersion: 35;
  /** Where independent measurements above converge; pure composition. */
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
  /** Analysis policy override; defaults to ANALYSIS_CONFIG. */
  config?: AnalysisConfig;
  /** Clock for churn windows and recency; defaults to the wall clock. */
  now?: Date;
  /**
   * `temporal` (V12.3) keeps every stage but reports external symbol usage as
   * unmeasured and Git history as unavailable: the two costs a historical
   * checkpoint does not need. Defaults to `full`.
   */
  profile?: AnalysisProfile;
  /** Monorepo root. Defaults to the nearest ancestor of cwd with a workspaces field. */
  root?: string;
  /** Directory path (relative to root) or workspace package name. */
  target: string;
  /** Optional tsconfig path (relative to root) used for compiler options / path aliases. */
  tsconfig?: string;
}

export type AnalysisProfile = "full" | "temporal";
