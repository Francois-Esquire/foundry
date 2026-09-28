import type {
  ResponsibilityAmbiguityReason,
  ResponsibilityModuleStatus,
} from "./internal-responsibility-types";
import type { PackageLocalBindingUses } from "./package-local-types";
import type {
  ArchitecturalRole,
  ArchitecturalScopeClass,
} from "./primitive-convention-types";
import type { DeclarationPlacement } from "./symbol-locality-types";
import type { ConceptRelationshipKind } from "./types";

// V13.4 internal rewiring scenarios: counterfactual arrangements of one
// package's symbols, modules, and internal dependencies, derived from the
// V13.0–V13.3 reports. A scenario describes what would change and what it
// would preserve; several scenarios may exist for one subject, the
// baseline among them, and nothing here ranks them. Broadness alone is not
// tension: package-wide primitives, cross-responsibility contracts, and
// composition roots receive preservation scenarios. No source is read or
// written; targets stop at an architectural scope, never an exact path.

export const INTERNAL_REWIRING_SCHEMA_VERSION = 1;

/**
 * How a module consumes the responsibilities it depends on, from the
 * syntactic uses of its internal import bindings. `composition`: constructs
 * or renders bindings from several responsibilities; `registration`: places
 * them in literal collections; `orchestration`: calls them; `provision`:
 * passes them into other calls; `aggregation`: a syntactic aggregator;
 * `ordinary-dependency`: one responsibility, or plain use; `unclear`: wide
 * dependency without wiring evidence.
 */
export type CompositionRoleKind =
  | "composition"
  | "registration"
  | "orchestration"
  | "provision"
  | "aggregation"
  | "ordinary-dependency"
  | "unclear";

/** The module's internal import bindings' uses, summed. */
type CompositionWiring = PackageLocalBindingUses;

export interface CompositionEvidence {
  ambiguity?: ResponsibilityAmbiguityReason;
  behaviorMass: number;
  /** Meets every composition-root criterion of the policy. */
  compositionRoot: boolean;
  declaredSymbols: number;
  evidence: string[];
  exportedSymbols: number;
  fanIn: number;
  fanOut: number;
  module: string;
  providedSymbols: number;
  /** Distinct placed responsibilities its outgoing primary edges reach, its own excluded; sorted. */
  responsibilities: string[];
  responsibility?: string;
  roles: CompositionRoleKind[];
  status: ResponsibilityModuleStatus;
  unresolvedTargets: number;
  /** Responsibilities whose bindings the module constructs, renders, collects, or passes on; sorted. */
  wiredResponsibilities: string[];
  wiring: CompositionWiring;
}

export type InternalRewiringScenarioKind =
  | "preserve-current"
  | "demote-primitive"
  | "colocate-primitive"
  | "promote-primitive"
  | "split-module-by-responsibility"
  | "split-module-by-role"
  | "align-with-convention"
  | "formalize-cross-responsibility-contract"
  | "formalize-responsibility-surface"
  | "redirect-internal-dependency"
  | "collapse-indirection"
  | "preserve-package-primitive"
  | "preserve-composition-root"
  | "preserve-cross-responsibility-contract";

export type ScenarioSubjectKind =
  | "symbol-group"
  | "module"
  | "responsibility-relationship"
  | "internal-dependency";

export interface ScenarioSubject {
  edges?: { source: string; target: string }[];
  /** Stable key: the module; `<module>|<target>` for a symbol group; `<from>→<to>` for a relationship or dependency. */
  key: string;
  kind: ScenarioSubjectKind;
  module?: string;
  relationship?: { from: string; to: string };
  /** Sorted. */
  symbolIds?: string[];
}

/** V13.3 evidence a candidate came from. */
export type CandidateSource =
  | "declared-outside-served-responsibility"
  | "declared-in-unresolved-module"
  | "cross-responsibility"
  | "package-wide"
  | "mixed-scope"
  | "mixed-role"
  | "composition-root"
  | "wide-dependent"
  | "convention-outlier"
  | "deep-responsibility-dependency"
  | "contract-beside-implementation"
  | "indirection";

export interface ScopeGroup {
  /** `responsibility-local:<id>`, or the scope class. */
  key: string;
  responsibility?: string;
  roles: Partial<Record<ArchitecturalRole, number>>;
  scope: ArchitecturalScopeClass;
  symbolIds: string[];
}

export interface RoleGroup {
  role: ArchitecturalRole;
  symbolIds: string[];
}

export type LocalityRelation =
  | "declared-in-serving-responsibility"
  | "declared-outside-serving-responsibility"
  | "declared-in-unresolved-module"
  | "declared-in-one-serving-responsibility"
  | "declared-at-shared-scope"
  | "not-applicable";

export interface CurrentArrangement {
  compositionRoles?: CompositionRoleKind[];
  consumerModules?: number;
  /** Distinct consumer responsibilities of the subject symbols, sorted. */
  consumerResponsibilities?: string[];
  dependency?: { edges: number; symbols: number };
  locality?: LocalityRelation;
  module?: string;
  moduleStatus?: ResponsibilityModuleStatus;
  /** V13.1 placement of the subject symbols, where measured. */
  placements?: Partial<Record<DeclarationPlacement, number>>;
  relationship?: {
    moduleEdges: number;
    symbolFlow: number;
    sourceModules: number;
    targetModules: number;
  };
  responsibility?: string;
  roleGroups?: RoleGroup[];
  /** Roles of the subject symbols, or of the module's exported symbols. */
  roles?: Partial<Record<ArchitecturalRole, number>>;
  scope?: ArchitecturalScopeClass;
  /** Modules: exported symbols by scope group. */
  scopeGroups?: ScopeGroup[];
  unresolvedConsumers?: number;
}

type ProposedScope =
  | "unchanged"
  | "responsibility-local"
  | "cross-responsibility"
  | "package-wide"
  | "dedicated-role-modules"
  | "responsibility-surface"
  | "cross-responsibility-surface"
  | "direct-dependency";

export type TargetEvidence =
  | "same-responsibility"
  | "only-module-in-responsibility"
  | "dedicated-role-module"
  | "matching-convention"
  | "same-concept"
  | "existing-hub";

export interface ProposedArrangement {
  /** Existing modules matching the intended role, scope, and convention; never a fabricated path. */
  candidateModules: { module: string; evidence: TargetEvidence[] }[];
  collapse?: { intermediary: string; consumer: string; providers: string[] };
  exactPath: "deferred";
  /** Redirects: consumer edges that would point at the new location. */
  redirect?: { source: string; target: string; symbolIds: string[] }[];
  /** Splits: groups that stay. */
  remainder?: ScopeGroup[];
  responsibility?: string;
  scope: ProposedScope;
  /** Splits: groups separated from the module. */
  separated?: ScopeGroup[] | RoleGroup[];
  surface?: {
    responsibility: string;
    consumerModules: string[];
    deepModules: string[];
    symbolIds: string[];
  };
}

export interface BeforeAfter {
  after: number;
  before: number;
}

export type ConventionAlignment =
  | "matches-convention"
  | "differs-from-convention"
  | "competing-convention"
  | "no-applicable-convention";

export type CycleOutcome =
  | "none"
  | "unchanged"
  | "membership-removed"
  | "potential-new-cycle";

export interface InternalRewiringEffects {
  conventions: { alignment: ConventionAlignment; conventionIds: string[] };
  cycles: { membership: string[]; outcome: CycleOutcome; detail?: string };
  dependencies: {
    edgesRemoved: number;
    edgesAdded: number;
    edgesRetargeted: number;
    /** Affected modules, by module. */
    modules: { module: string; fanIn: BeforeAfter; fanOut: BeforeAfter }[];
    /** Distinct target modules a consuming responsibility reaches. */
    deepImports?: BeforeAfter;
  };
  locality: {
    symbols: number;
    before: LocalityRelation;
    after: LocalityRelation;
  };
  moduleComposition: {
    module: string;
    scopeGroups: BeforeAfter;
    roleGroups: BeforeAfter;
    /** Primary modules in the package. */
    modules: BeforeAfter;
  };
  responsibilityBoundaries: {
    /** Primary edges with both endpoints in one responsibility. */
    withinEdges: BeforeAfter;
    /** Both endpoints placed, in different responsibilities. */
    crossEdges: BeforeAfter;
    /** An endpoint unresolved. */
    unresolvedEdges: BeforeAfter;
    /** Subject symbols consumed outside their declaring responsibility. */
    crossingSymbols: BeforeAfter;
    responsibilitiesTouched: string[];
  };
}

export type ClosureRelationship =
  | "annotation"
  | "type-query"
  | "callee"
  | ConceptRelationshipKind;

export type ClosureSize = "independent" | "small" | "large" | "unresolved";

/**
 * Same-module declarations a moving group depends on, from declaration-level
 * facts alone. `required`: module-local and used by the group only.
 * `optional`: exported, so it can stay and be imported back. `blockers`:
 * module-local and also used by what stays, or a staying declaration that
 * depends on the group.
 */
export interface SymbolMovementClosure {
  blockers: {
    symbolId: string;
    reason: "shared-module-local-dependency" | "reverse-dependency";
  }[];
  optional: { symbolId: string; relationships: ClosureRelationship[] }[];
  required: { symbolId: string; relationships: ClosureRelationship[] }[];
  size: ClosureSize;
  subject: string[];
}

export type RewiringPreservation =
  | "symbol-identity"
  | "module-identity"
  | "responsibility-ownership"
  | "package-wide-scope"
  | "cross-responsibility-contract"
  | "composition-role"
  | "public-exposure"
  | "cycle-atomicity";

export type ScenarioUncertaintyReason =
  | "unresolved-consumers"
  | "package-public-external-impact"
  | "namespace-identity-gap"
  | "composition-role-unclear"
  | "movement-closure-incomplete"
  | "large-closure"
  | "closure-blocked"
  | "closure-crosses-groups"
  | "cycle-membership"
  | "composition-root-membership"
  | "target-module-unresolved"
  | "internal-anchors-unavailable";

export interface ScenarioUncertainty {
  detail: string;
  reason: ScenarioUncertaintyReason;
}

export interface ScenarioProvenance {
  /** V13.1 symbol ids with a locality finding. */
  locality: string[];
  /** V13.3 symbol, module, and convention ids. */
  primitives: string[];
  /** V13.2 responsibility ids and relationships. */
  responsibilities: string[];
  /** V13.0 module, edge (`source→target`), and cycle ids. */
  topology: string[];
}

export interface InternalRewiringScenario {
  closure?: SymbolMovementClosure;
  current: CurrentArrangement;
  effects: InternalRewiringEffects;
  /** `<kind>:<hash>` over the kind, the subject ids, and the proposed target. */
  id: string;
  kind: InternalRewiringScenarioKind;
  preservations: RewiringPreservation[];
  proposed: ProposedArrangement;
  provenance: ScenarioProvenance;
  rationale: { sources: CandidateSource[]; facts: string[] };
  subject: ScenarioSubject;
  uncertainties: ScenarioUncertainty[];
}

export interface ScenarioEligibility {
  eligible: boolean;
  missingEvidence: string[];
  reasons: string[];
}

export interface ScenarioCandidate {
  eligibility: ScenarioEligibility;
  kind: InternalRewiringScenarioKind;
  scenarioId?: string;
  source: CandidateSource;
  subject: ScenarioSubject;
}

/** Every scenario for one subject, the baseline first. */
export interface ScenarioFamily {
  /** Only preservation scenarios. */
  preservationOnly: boolean;
  scenarioIds: string[];
  subject: ScenarioSubject;
}

export interface InternalRewiringSummary {
  byKind: Record<InternalRewiringScenarioKind, number>;
  byPreservation: Record<RewiringPreservation, number>;
  bySubjectKind: Record<ScenarioSubjectKind, number>;
  byUncertainty: Record<ScenarioUncertaintyReason, number>;
  candidates: { total: number; eligible: number; ineligible: number };
  closures: Record<ClosureSize, number>;
  composition: {
    modules: number;
    byRole: Record<CompositionRoleKind, number>;
    roots: number;
    /** V13.2 wide-dependent unresolved modules, and how many composition evidence explains. */
    wideDependents: { total: number; roots: number; unclear: number };
  };
  conventions: Record<ConventionAlignment, number>;
  cycles: Record<CycleOutcome, number>;
  effects: {
    crossEdgesReduced: number;
    crossEdgesIncreased: number;
    unresolvedEdgesReduced: number;
    localDeclarationsMoved: number;
    packageWidePreserved: number;
  };
  families: {
    total: number;
    withAlternatives: number;
    preservationOnly: number;
    /** Subjects whose every candidate was ineligible. */
    insufficientEvidence: number;
  };
  scenarios: number;
}

interface InternalRewiringPolicy {
  /** A convention is strong enough to name an outlier at this support-to-exception ratio. */
  alignment: { minimumSupportRatio: number };
  candidateModules: number;
  closure: { largeShare: number };
  compositionRoleDefinitions: Record<CompositionRoleKind, string>;
  compositionRoles: CompositionRoleKind[];
  compositionRoot: {
    minimumResponsibilities: number;
    maximumExportedSymbols: number;
    minimumWiringSites: number;
    minimumWiredResponsibilities: number;
  };
  contract: { minimumSymbols: number };
  eligibility: Record<InternalRewiringScenarioKind, string>;
  identity: "sha256 over the kind, the sorted subject ids, and the proposed target";
  indirection: {
    maximumProviders: number;
    maximumExportedSymbols: number;
    maximumStatements: number;
  };
  kindDefinitions: Record<InternalRewiringScenarioKind, string>;
  kinds: InternalRewiringScenarioKind[];
  orchestration: { maximumExportedSymbols: number };
  order: "subject key, then kind order with preserve-current first";
  ranking: "none";
  split: { minimumGroupSymbols: number };
  surface: { minimumTargetModules: number; minimumSymbols: number };
  targets: "architectural scope and existing candidate modules; exact paths deferred";
}

export interface InternalRewiringReport {
  /** By subject key, then kind. */
  candidates: ScenarioCandidate[];
  /** Every primary module, by module. */
  composition: CompositionEvidence[];
  families: ScenarioFamily[];
  limitations: string[];
  package: { id: string; root: string };
  policy: InternalRewiringPolicy;
  scenarios: InternalRewiringScenario[];
  schemaVersion: typeof INTERNAL_REWIRING_SCHEMA_VERSION;
  summary: InternalRewiringSummary;
}
