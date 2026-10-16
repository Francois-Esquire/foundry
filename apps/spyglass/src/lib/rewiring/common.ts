import { createHash } from "node:crypto";
import type { InternalResponsibilityReport } from "../internal-responsibility-types";
import type {
  BeforeAfter,
  ClosureSize,
  CompositionEvidence,
  CompositionRoleKind,
  ConventionAlignment,
  CurrentArrangement,
  CycleOutcome,
  InternalRewiringEffects,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
  InternalRewiringSummary,
  RewiringPreservation,
  RoleGroup,
  ScenarioCandidate,
  ScenarioEligibility,
  ScenarioFamily,
  ScenarioProvenance,
  ScenarioSubject,
  ScenarioSubjectKind,
  ScenarioUncertainty,
  ScenarioUncertaintyReason,
  ScopeGroup,
  SymbolMovementClosure,
  TargetEvidence,
} from "../internal-rewiring-types";
import type { PackageLocalBindingUses } from "../package-local-types";
import type {
  ArchitecturalRole,
  ArchitecturalRoleFinding,
} from "../primitive-convention-types";
import type { ConceptRelationshipKind } from "../types";
import type { ScenarioCollection } from "./construction";
import type { MovementAnalysis } from "./movement";
export const splitScenarioPattern = /^responsibility-local:/;
// V13.4 internal rewiring scenarios. A pure function of the five
// package-intelligence reports: no file system, no program, no workspace.
// Candidates come from V13.3 findings (a local symbol declared elsewhere, a
// broad symbol declared narrowly, a mixed module, a deep dependency, a thin
// intermediary); each kind has explicit eligibility; each scenario carries
// its current arrangement, an architectural target, simulated effects over
// the affected subgraph, what it preserves, and what stays uncertain. A
// broad primitive or a composition root gets a preservation scenario, not
// a move. Nothing here ranks; V13.5 compares.
export const KINDS: InternalRewiringScenarioKind[] = [
  "preserve-current",
  "demote-primitive",
  "colocate-primitive",
  "promote-primitive",
  "split-module-by-responsibility",
  "split-module-by-role",
  "align-with-convention",
  "formalize-cross-responsibility-contract",
  "formalize-responsibility-surface",
  "redirect-internal-dependency",
  "collapse-indirection",
  "preserve-package-primitive",
  "preserve-composition-root",
  "preserve-cross-responsibility-contract",
];
export const PRESERVING_KINDS: InternalRewiringScenarioKind[] = [
  "preserve-current",
  "preserve-package-primitive",
  "preserve-composition-root",
  "preserve-cross-responsibility-contract",
];
export const KIND_DEFINITIONS: Record<InternalRewiringScenarioKind, string> = {
  "align-with-convention":
    "symbols placed against a strong dedicated-role-module convention of their role and scope; place them in a dedicated-role module of the same scope",
  "collapse-indirection":
    "a thin intermediary with one consumer, one or more providers, no contract, and no concept; let the consumer depend on the providers",
  "colocate-primitive":
    "a responsibility-local symbol declared in an unresolved module; place it within the responsibility it serves",
  "demote-primitive":
    "a responsibility-local symbol declared in a module placed in another responsibility; place it within the responsibility it serves",
  "formalize-cross-responsibility-contract":
    "contract-family symbols consumed across a responsibility relationship while declared beside behavior; expose them through an explicit contract surface of the owning responsibility",
  "formalize-responsibility-surface":
    "one responsibility reaching several deep modules of another; expose a coherent internal surface of the target responsibility",
  "preserve-composition-root":
    "a module whose role is wiring several responsibilities; keep it, and keep its breadth",
  "preserve-cross-responsibility-contract":
    "a contract-family symbol shared by a few responsibilities and owned by one of them or by a hub; keep it",
  "preserve-current": "the baseline for every subject with a scenario",
  "preserve-package-primitive":
    "a package-wide symbol; keep its broad scope where it is",
  "promote-primitive":
    "a cross-responsibility or package-wide symbol declared inside one placed responsibility; place it at the scope its consumers span",
  "redirect-internal-dependency":
    "the consumer edges that would follow a placement scenario: the same symbols, imported from their responsibility",
  "split-module-by-responsibility":
    "a mixed-scope module; separate its responsibility-local groups, keeping cross-responsibility and package-wide groups together",
  "split-module-by-role":
    "a mixed-role, single-scope module in a package that separates those roles elsewhere; group its exported symbols by role",
};
export const ELIGIBILITY: Record<InternalRewiringScenarioKind, string> = {
  "align-with-convention":
    "an exception to a dedicated-role-module convention (single qualifying value) whose support is at least the ratio times its exceptions; the declaring module is not itself a split subject for that role",
  "collapse-indirection":
    "a primary module with one consumer, at least one provider, few exports, little behavior, no declared concept, no cycle, and no contract, adapter, or implementation role",
  "colocate-primitive":
    "scope responsibility-local; declaring module unresolved; consumer evidence complete or partial",
  "demote-primitive":
    "scope responsibility-local; declaring module assigned or attached to a different responsibility; consumer evidence complete or partial",
  "formalize-cross-responsibility-contract":
    "a responsibility relationship carrying at least the minimum contract-family symbols declared in modules that also export behavior",
  "formalize-responsibility-surface":
    "a responsibility relationship reaching at least the minimum distinct target modules with at least the minimum symbols",
  "preserve-composition-root": "meets every composition-root criterion",
  "preserve-cross-responsibility-contract":
    "scope cross-responsibility; contract-family role; declared in an unresolved module, a dedicated-role module, or a consuming responsibility",
  "preserve-current": "any subject with at least one other scenario",
  "preserve-package-primitive": "scope package-wide",
  "promote-primitive":
    "scope cross-responsibility or package-wide; declaring module placed; at least two consumer responsibilities other than the declaring one",
  "redirect-internal-dependency":
    "an eligible demote or colocate scenario with at least one consumer edge",
  "split-module-by-responsibility":
    "module mixed-scope; at least one responsibility-local group at or above the minimum group size",
  "split-module-by-role":
    "module mixed-role with one scope group; at least two role groups at or above the minimum; an observed dedicated-role-module convention for one of those roles at that scope",
};
export const COMPOSITION_ROLES: CompositionRoleKind[] = [
  "composition",
  "registration",
  "orchestration",
  "provision",
  "aggregation",
  "ordinary-dependency",
  "unclear",
];
export const COMPOSITION_ROLE_DEFINITIONS: Record<CompositionRoleKind, string> =
  {
    aggregation: "a syntactic aggregator",
    composition:
      "constructs or renders bindings from at least the minimum wired responsibilities",
    orchestration:
      "calls bindings from at least the minimum wired responsibilities while exporting at most the orchestration maximum",
    "ordinary-dependency":
      "fewer than two responsibilities depended on, or none of the wiring shapes across them",
    provision:
      "passes bindings from at least the minimum wired responsibilities into calls",
    registration:
      "places bindings from at least the minimum wired responsibilities in object or array literals",
    unclear:
      "an unresolved wide-dependent module without wiring evidence across responsibilities",
  };
const SUBJECT_KINDS: ScenarioSubjectKind[] = [
  "symbol-group",
  "module",
  "responsibility-relationship",
  "internal-dependency",
];
const ALIGNMENTS: ConventionAlignment[] = [
  "matches-convention",
  "differs-from-convention",
  "competing-convention",
  "no-applicable-convention",
];
const CYCLE_OUTCOMES: CycleOutcome[] = [
  "none",
  "unchanged",
  "membership-removed",
  "potential-new-cycle",
];
const CLOSURE_SIZES: ClosureSize[] = [
  "independent",
  "small",
  "large",
  "unresolved",
];
const PRESERVATIONS: RewiringPreservation[] = [
  "symbol-identity",
  "module-identity",
  "responsibility-ownership",
  "package-wide-scope",
  "cross-responsibility-contract",
  "composition-role",
  "public-exposure",
  "cycle-atomicity",
];
export const UNCERTAINTIES: ScenarioUncertaintyReason[] = [
  "unresolved-consumers",
  "package-public-external-impact",
  "namespace-identity-gap",
  "composition-role-unclear",
  "movement-closure-incomplete",
  "large-closure",
  "closure-blocked",
  "closure-crosses-groups",
  "cycle-membership",
  "composition-root-membership",
  "target-module-unresolved",
  "internal-anchors-unavailable",
];
export const CONTRACT_FAMILY: ArchitecturalRole[] = [
  "contract",
  "type",
  "representation",
  "identifier",
  "configuration",
  "schema",
  "constant",
];
export const EXECUTABLE_ROLES: ArchitecturalRole[] = [
  "factory",
  "adapter",
  "implementation",
  "behavior",
  "utility",
];
export const STRUCTURAL_ROLES: ArchitecturalRole[] = [
  "contract",
  "adapter",
  "implementation",
];
/** Roles whose symbols an existing module can plausibly host by role alone. */
export const HOSTABLE_ROLES: ArchitecturalRole[] = [
  ...CONTRACT_FAMILY,
  "utility",
];
export const WIRING_ROLES: CompositionRoleKind[] = [
  "composition",
  "registration",
  "orchestration",
  "provision",
];
export const USE_KEYS: (keyof PackageLocalBindingUses)[] = [
  "constructed",
  "called",
  "argument",
  "collected",
  "rendered",
];
export const EMPTY_USES: PackageLocalBindingUses = {
  argument: 0,
  called: 0,
  collected: 0,
  constructed: 0,
  rendered: 0,
};
export const RELATIONSHIP_KINDS: ConceptRelationshipKind[] = [
  "implements",
  "extends",
  "alias",
  "type-reference",
  "parameter-type",
  "return-type",
  "property-type",
  "constructs",
];
export interface MoveSimulation {
  closure: SymbolMovementClosure;
  edges: {
    source: string;
    target: string;
    symbolIds: string[];
  }[];
  effects: InternalRewiringEffects;
}
function zeroRecord<K extends string>(keys: K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}
export function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
export function increment<K extends string>(
  record: Partial<Record<K, number>>,
  key: K
): void {
  record[key] = (record[key] ?? 0) + 1;
}
export function sortedPartial<K extends string>(
  record: Partial<Record<K, number>>
): Partial<Record<K, number>> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
  ) as Partial<Record<K, number>>;
}
export function roleCounts(
  findings: ArchitecturalRoleFinding[]
): Partial<Record<ArchitecturalRole, number>> {
  const counts: Partial<Record<ArchitecturalRole, number>> = {};
  for (const finding of findings) {
    increment(counts, finding.primaryRole);
  }
  return sortedPartial(counts);
}
export function scenarioId(
  kind: InternalRewiringScenarioKind,
  referencedSubjectIds: string[],
  target: string
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([kind, sorted(referencedSubjectIds), target]))
    .digest("hex")
    .slice(0, 12);
  return `${kind}:${hash}`;
}
export function subjectIds(subject: ScenarioSubject): string[] {
  if (subject.symbolIds !== undefined) {
    return subject.symbolIds;
  }
  if (subject.relationship !== undefined) {
    return [`${subject.relationship.from}→${subject.relationship.to}`];
  }
  if (subject.edges !== undefined) {
    return subject.edges.map((edge) => `${edge.source}→${edge.target}`);
  }
  return subject.module === undefined ? [] : [subject.module];
}
export function same(value: number): BeforeAfter {
  return { after: value, before: value };
}
export function scopeGroupKey(finding: ArchitecturalRoleFinding): string {
  return finding.scope === "responsibility-local"
    ? `responsibility-local:${finding.served?.responsibility ?? ""}`
    : finding.scope;
}
export function scopeGroups(
  findings: ArchitecturalRoleFinding[]
): ScopeGroup[] {
  const groups = new Map<string, ArchitecturalRoleFinding[]>();
  for (const finding of findings) {
    const key = scopeGroupKey(finding);
    const list = groups.get(key) ?? [];
    list.push(finding);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map<ScopeGroup>(([key, members]) => {
      const [first] = members;
      return {
        key,
        scope: first?.scope ?? "unclear",
        ...(first?.served !== undefined &&
          first.scope === "responsibility-local" && {
            responsibility: first.served.responsibility,
          }),
        roles: roleCounts(members),
        symbolIds: sorted(members.map((m) => m.symbolId)),
      };
    })
    .sort(
      (a, b) =>
        b.symbolIds.length - a.symbolIds.length || a.key.localeCompare(b.key)
    );
}
export function roleGroups(findings: ArchitecturalRoleFinding[]): RoleGroup[] {
  const groups = new Map<ArchitecturalRole, string[]>();
  for (const finding of findings) {
    const list = groups.get(finding.primaryRole) ?? [];
    list.push(finding.symbolId);
    groups.set(finding.primaryRole, list);
  }
  return [...groups.entries()]
    .map(([role, ids]) => ({ role, symbolIds: sorted(ids) }))
    .sort(
      (a, b) =>
        b.symbolIds.length - a.symbolIds.length || a.role.localeCompare(b.role)
    );
}
export function createPromotionScenario(
  simulation: MoveSimulation | undefined,
  current: CurrentArrangement,
  subject: ScenarioSubject,
  scope: "cross-responsibility" | "package-wide",
  basePreservations: RewiringPreservation[],
  group: ArchitecturalRoleFinding[],
  targetModules: {
    module: string;
    evidence: TargetEvidence[];
  }[],
  provenance: ScenarioProvenance,
  facts: string[],
  source: "cross-responsibility" | "package-wide",
  symbolUncertainties: (
    group: ArchitecturalRoleFinding[],
    module: string,
    closure: SymbolMovementClosure | undefined,
    movement: boolean,
    targetKnown: boolean
  ) => ScenarioUncertainty[],
  module: string
): InternalRewiringScenario | undefined {
  if (simulation === undefined) {
    return undefined;
  }
  return {
    closure: simulation.closure,
    current,
    effects: simulation.effects,
    id: scenarioId("promote-primitive", subject.symbolIds ?? [], scope),
    kind: "promote-primitive",
    // Promotion places the group at the scope its consumers measured, so that scope survives by construction.
    preservations: [
      ...basePreservations,
      ...resolvePreservations(scope, group),
      ...(simulation.effects.cycles.outcome === "unchanged"
        ? (["cycle-atomicity"] as RewiringPreservation[])
        : []),
    ],
    proposed: {
      candidateModules: targetModules,
      exactPath: "deferred",
      scope,
    },
    provenance,
    rationale: { facts, sources: [source] },
    subject,
    uncertainties: symbolUncertainties(
      group,
      module,
      simulation.closure,
      true,
      targetModules.length > 0
    ),
  };
}
function resolvePreservations(
  scope: "cross-responsibility" | "package-wide",
  group: ArchitecturalRoleFinding[]
): RewiringPreservation[] {
  if (scope === "package-wide") {
    return ["package-wide-scope"] as RewiringPreservation[];
  }
  if (group.some((f) => CONTRACT_FAMILY.includes(f.primaryRole))) {
    return ["cross-responsibility-contract"] as RewiringPreservation[];
  }
  return [];
}
export function createContractPreservation(
  holds: boolean,
  contracts: ArchitecturalRoleFinding[],
  module: string,
  first: ArchitecturalRoleFinding,
  noConvention: {
    alignment: "no-applicable-convention";
    conventionIds: never[];
  },
  preserveSubject: ScenarioSubject,
  declaringRegion: string | undefined,
  basePreservations: RewiringPreservation[],
  provenance: ScenarioProvenance,
  source: "cross-responsibility" | "package-wide",
  movement: Pick<
    MovementAnalysis,
    "noEffects" | "localityOf" | "symbolUncertainties"
  >,
  collection: Pick<ScenarioCollection, "currentOfGroup" | "factsOfGroup">
): InternalRewiringScenario | undefined {
  if (holds) {
    return {
      current: collection.currentOfGroup(contracts, module),
      effects: movement.noEffects(
        module,
        contracts.length,
        movement.localityOf(first),
        noConvention
      ),
      id: scenarioId(
        "preserve-cross-responsibility-contract",
        preserveSubject.symbolIds ?? [],
        "cross-responsibility"
      ),
      kind: "preserve-cross-responsibility-contract",
      preservations: [
        "module-identity",
        "cross-responsibility-contract",
        ...(declaringRegion === undefined
          ? []
          : (["responsibility-ownership"] as RewiringPreservation[])),
        ...basePreservations,
      ],
      proposed: {
        scope: "cross-responsibility",
        ...(declaringRegion !== undefined && {
          responsibility: declaringRegion,
        }),
        candidateModules: [],
        exactPath: "deferred",
      },
      provenance,
      rationale: {
        facts: collection.factsOfGroup(contracts),
        sources: [source],
      },
      subject: preserveSubject,
      uncertainties: movement.symbolUncertainties(
        contracts,
        module,
        undefined,
        false,
        true
      ),
    };
  }
  return undefined;
}
export function contractPreservationEligibility(
  holds: boolean,
  eligible: (reasons: string[]) => ScenarioEligibility,
  contracts: ArchitecturalRoleFinding[],
  foreign: string[],
  ownedByConsumer: boolean,
  first: ArchitecturalRoleFinding,
  dedicated: boolean,
  ineligible: (reasons: string[], missing: string[]) => ScenarioEligibility
): ScenarioEligibility {
  if (holds) {
    return eligible([
      `${contracts.length} contract-family symbols shared by ${foreign.length + (ownedByConsumer ? 1 : 0)} responsibilities`,
      contractOwnershipReason(first, dedicated),
    ]);
  }
  return ineligible(
    ["declared in a responsibility that does not consume it"],
    ["ownership by a consumer, a dedicated-role module, or a hub"]
  );
}
function contractOwnershipReason(
  first: ArchitecturalRoleFinding,
  dedicated: boolean
): string {
  if (first.declaration.placed) {
    if (dedicated) {
      return "declared in a dedicated-role module";
    }
    return "owned by a consuming responsibility";
  }
  return "declared in an unresolved module";
}
export function summarize(
  scenarios: InternalRewiringScenario[],
  candidates: ScenarioCandidate[],
  families: ScenarioFamily[],
  composition: CompositionEvidence[],
  responsibilities: InternalResponsibilityReport
): InternalRewiringSummary {
  const byKind = zeroRecord(KINDS);
  const bySubjectKind = zeroRecord(SUBJECT_KINDS);
  const conventions = zeroRecord(ALIGNMENTS);
  const cycles = zeroRecord(CYCLE_OUTCOMES);
  const closures = zeroRecord(CLOSURE_SIZES);
  const byPreservation = zeroRecord(PRESERVATIONS);
  const byUncertainty = zeroRecord(UNCERTAINTIES);
  const effects = {
    crossEdgesIncreased: 0,
    crossEdgesReduced: 0,
    localDeclarationsMoved: 0,
    packageWidePreserved: 0,
    unresolvedEdgesReduced: 0,
  };
  summarizeScenario(
    scenarios,
    byKind,
    bySubjectKind,
    conventions,
    cycles,
    closures,
    byPreservation,
    byUncertainty,
    effects
  );
  const familyKeys = new Set(families.map((f) => f.subject.key));
  const ineligibleSubjects = new Set(
    candidates
      .filter((c) => !c.eligibility.eligible)
      .map((c) => c.subject.key)
      .filter((key) => !familyKeys.has(key))
  );
  const byRole = zeroRecord(COMPOSITION_ROLES);
  for (const entry of composition) {
    for (const role of entry.roles) {
      byRole[role] += 1;
    }
  }
  const wideDependents = responsibilities.unresolved.filter(
    (u) => u.reason === "wide-dependent"
  );
  const compositionByModule = new Map(composition.map((c) => [c.module, c]));
  return {
    byKind,
    byPreservation,
    bySubjectKind,
    byUncertainty,
    candidates: {
      eligible: candidates.filter((c) => c.eligibility.eligible).length,
      ineligible: candidates.filter((c) => !c.eligibility.eligible).length,
      total: candidates.length,
    },
    closures,
    composition: {
      byRole,
      modules: composition.filter((c) => c.responsibilities.length >= 2).length,
      roots: composition.filter((c) => c.compositionRoot).length,
      wideDependents: {
        roots: wideDependents.filter(
          (u) => compositionByModule.get(u.module)?.compositionRoot === true
        ).length,
        total: wideDependents.length,
        unclear: wideDependents.filter((u) =>
          compositionByModule.get(u.module)?.roles.includes("unclear")
        ).length,
      },
    },
    conventions,
    cycles,
    effects,
    families: {
      insufficientEvidence: ineligibleSubjects.size,
      preservationOnly: families.filter((f) => f.preservationOnly).length,
      total: families.length,
      withAlternatives: families.filter((f) => !f.preservationOnly).length,
    },
    scenarios: scenarios.length,
  };
}
function summarizeScenario(
  scenarios: InternalRewiringScenario[],
  byKind: Record<InternalRewiringScenarioKind, number>,
  bySubjectKind: Record<ScenarioSubjectKind, number>,
  conventions: Record<ConventionAlignment, number>,
  cycles: Record<CycleOutcome, number>,
  closures: Record<ClosureSize, number>,
  byPreservation: Record<RewiringPreservation, number>,
  byUncertainty: Record<ScenarioUncertaintyReason, number>,
  effects: {
    crossEdgesIncreased: number;
    crossEdgesReduced: number;
    localDeclarationsMoved: number;
    packageWidePreserved: number;
    unresolvedEdgesReduced: number;
  }
) {
  for (const scenario of scenarios) {
    countScenarioEffects(
      byKind,
      scenario,
      bySubjectKind,
      conventions,
      cycles,
      closures,
      byPreservation,
      byUncertainty,
      effects
    );
  }
}
function countScenarioEffects(
  byKind: Record<InternalRewiringScenarioKind, number>,
  scenario: InternalRewiringScenario,
  bySubjectKind: Record<ScenarioSubjectKind, number>,
  conventions: Record<ConventionAlignment, number>,
  cycles: Record<CycleOutcome, number>,
  closures: Record<ClosureSize, number>,
  byPreservation: Record<RewiringPreservation, number>,
  byUncertainty: Record<ScenarioUncertaintyReason, number>,
  effects: {
    crossEdgesIncreased: number;
    crossEdgesReduced: number;
    localDeclarationsMoved: number;
    packageWidePreserved: number;
    unresolvedEdgesReduced: number;
  }
) {
  byKind[scenario.kind] += 1;
  bySubjectKind[scenario.subject.kind] += 1;
  if (!PRESERVING_KINDS.includes(scenario.kind)) {
    conventions[scenario.effects.conventions.alignment] += 1;
    cycles[scenario.effects.cycles.outcome] += 1;
  }
  if (scenario.closure !== undefined) {
    closures[scenario.closure.size] += 1;
  }
  for (const p of scenario.preservations) {
    byPreservation[p] += 1;
  }
  for (const u of scenario.uncertainties) {
    byUncertainty[u.reason] += 1;
  }
  const cross = scenario.effects.responsibilityBoundaries.crossEdges;
  if (cross.after < cross.before) {
    effects.crossEdgesReduced += 1;
  }
  if (cross.after > cross.before) {
    effects.crossEdgesIncreased += 1;
  }
  const unresolved = scenario.effects.responsibilityBoundaries.unresolvedEdges;
  if (unresolved.after < unresolved.before) {
    effects.unresolvedEdgesReduced += 1;
  }
  if (
    scenario.kind === "demote-primitive" ||
    scenario.kind === "colocate-primitive"
  ) {
    effects.localDeclarationsMoved += scenario.subject.symbolIds?.length ?? 0;
  }
  if (scenario.kind === "preserve-package-primitive") {
    effects.packageWidePreserved += scenario.subject.symbolIds?.length ?? 0;
  }
}
