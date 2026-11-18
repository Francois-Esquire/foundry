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

export const INTERNAL_REWIRING_SCHEMA_VERSION = 1;

export type CompositionRoleKind =
  | "composition"
  | "registration"
  | "orchestration"
  | "provision"
  | "aggregation"
  | "ordinary-dependency"
  | "unclear";

type CompositionWiring = PackageLocalBindingUses;

export interface CompositionEvidence {
  ambiguity?: ResponsibilityAmbiguityReason;
  behaviorMass: number;
  compositionRoot: boolean;
  declaredSymbols: number;
  evidence: string[];
  exportedSymbols: number;
  fanIn: number;
  fanOut: number;
  module: string;
  providedSymbols: number;
  responsibilities: string[];
  responsibility?: string;
  roles: CompositionRoleKind[];
  status: ResponsibilityModuleStatus;
  unresolvedTargets: number;
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
  key: string;
  kind: ScenarioSubjectKind;
  module?: string;
  relationship?: { from: string; to: string };
  symbolIds?: string[];
}

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
  consumerResponsibilities?: string[];
  dependency?: { edges: number; symbols: number };
  locality?: LocalityRelation;
  module?: string;
  moduleStatus?: ResponsibilityModuleStatus;
  placements?: Partial<Record<DeclarationPlacement, number>>;
  relationship?: {
    moduleEdges: number;
    symbolFlow: number;
    sourceModules: number;
    targetModules: number;
  };
  responsibility?: string;
  roleGroups?: RoleGroup[];
  roles?: Partial<Record<ArchitecturalRole, number>>;
  scope?: ArchitecturalScopeClass;
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
  candidateModules: { module: string; evidence: TargetEvidence[] }[];
  collapse?: { intermediary: string; consumer: string; providers: string[] };
  exactPath: "deferred";
  redirect?: { source: string; target: string; symbolIds: string[] }[];
  remainder?: ScopeGroup[];
  responsibility?: string;
  scope: ProposedScope;
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
    modules: { module: string; fanIn: BeforeAfter; fanOut: BeforeAfter }[];
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
    modules: BeforeAfter;
  };
  responsibilityBoundaries: {
    withinEdges: BeforeAfter;
    crossEdges: BeforeAfter;
    unresolvedEdges: BeforeAfter;
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
  locality: string[];
  primitives: string[];
  responsibilities: string[];
  topology: string[];
}

export interface InternalRewiringScenario {
  closure?: SymbolMovementClosure;
  current: CurrentArrangement;
  effects: InternalRewiringEffects;
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

export interface ScenarioFamily {
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
    insufficientEvidence: number;
  };
  scenarios: number;
}

interface InternalRewiringPolicy {
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
  candidates: ScenarioCandidate[];
  composition: CompositionEvidence[];
  families: ScenarioFamily[];
  limitations: string[];
  package: { id: string; root: string };
  policy: InternalRewiringPolicy;
  scenarios: InternalRewiringScenario[];
  schemaVersion: typeof INTERNAL_REWIRING_SCHEMA_VERSION;
  summary: InternalRewiringSummary;
}
