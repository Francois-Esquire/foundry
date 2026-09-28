import { createHash } from "node:crypto";
import {
  getOperatorDefinition,
  scenarioOperatorMapping,
} from "./operator-catalog";
import type {
  ArchitecturalOperator,
  ArchitecturalOperatorKind,
  ArchitecturalOperatorStatus,
  OperatorConstraint,
  OperatorContext,
  OperatorEvidenceRef,
  OperatorExpectedEffect,
  OperatorFact,
  OperatorFingerprint,
  OperatorFromScenarioResult,
  OperatorIntent,
  OperatorPlacement,
  OperatorPrecondition,
  OperatorPreconditionKind,
  OperatorPreconditionResult,
  OperatorPreservation,
  OperatorScenarioSource,
  OperatorSubject,
  OperatorValidation,
  OperatorVerificationRequirement,
} from "./operator-types";
import { OPERATOR_SCHEMA_VERSION } from "./operator-types";
import type {
  ArchitecturalScenarioReview,
  InternalizeSymbolPlan,
  RecenteringScenario,
  RecenteringScenarioKind,
  ScenarioImpactAnalysis,
  ScenarioPlacement,
  ScenarioStructuralChangeKind,
  SurfaceReport,
} from "./types";
import { validateReductionPlan } from "./validate";
import { boundaryIdOf, byId, sorted } from "./workspace-projection";
import type { WorkspaceProjectionContext } from "./workspace-projection-types";
import type { WorkspaceConcept, WorkspacePackage } from "./workspace-types";

// Operators are built from canonical facts and validated against them
// again later. Building reads facts once into preconditions (expected =
// what was true); validating re-reads the same facts (actual). Nothing
// here inspects source files, and nothing here decides what to do.

// ---------------------------------------------------------------------------
// Context

function packageIdOf(report: SurfaceReport): string {
  return report.target.name ?? report.target.path;
}

/**
 * Attach the package-level V8 records (placements, impact vectors, reviews)
 * and legacy internalize plans that the workspace only digests. Scenarios
 * absent from the ingested workspace are ignored, so the context never
 * carries a scenario the canonical intelligence does not know.
 */
export function createOperatorContext(
  projection: WorkspaceProjectionContext,
  reports: readonly SurfaceReport[] = []
): OperatorContext {
  const scenarios = new Map<string, OperatorScenarioSource>();
  const reportsByPackage = new Map<string, SurfaceReport>();
  const legacyPlansById = new Map<
    string,
    { package: string; plan: InternalizeSymbolPlan }
  >();
  for (const report of reports) {
    const pkg = packageIdOf(report);
    reportsByPackage.set(pkg, report);
    for (const plan of report.plans) {
      if (plan.operation === "internalize-symbol") {
        legacyPlansById.set(plan.id, { package: pkg, plan });
      }
    }
    const recentering = report.recenteringCandidates;
    const impacts = new Map(
      recentering.impacts.findings
        .flatMap((f) => f.scenarios)
        .map((impact) => [impact.scenarioId, impact])
    );
    const reviews = new Map(
      recentering.reviews.reviews.map((review) => [review.findingId, review])
    );
    for (const finding of recentering.scenarios.findings) {
      for (const scenario of finding.scenarios) {
        if (!projection.lookup.scenarioById.has(scenario.id)) {
          continue;
        }
        const review = reviews.get(finding.findingId);
        const reviewed = review?.scenarios.find(
          (entry) => entry.scenarioId === scenario.id
        );
        const impact = impacts.get(scenario.id);
        scenarios.set(scenario.id, {
          package: pkg,
          scenario,
          ...(impact !== undefined && { impact }),
          ...(review !== undefined && { review }),
          ...(reviewed !== undefined && { reviewed }),
          ...(review !== undefined && { disposition: review.disposition }),
        });
      }
    }
  }
  return { legacyPlansById, projection, reportsByPackage, scenarios };
}

// ---------------------------------------------------------------------------
// Facts

function packageOf(
  context: OperatorContext,
  id: string
): WorkspacePackage | undefined {
  return context.projection.workspace.packages.packages.find(
    (p) => p.id === id
  );
}

function conceptOf(
  context: OperatorContext,
  id: string
): WorkspaceConcept | undefined {
  return context.projection.lookup.conceptById.get(id);
}

function placementPackages(
  placement: ScenarioPlacement,
  responsibility: "domain-behavior" | "semantic-contract"
): string[] {
  return sorted(
    placement.responsibilities.find((r) => r.responsibility === responsibility)
      ?.packages ?? []
  );
}

/** One deterministic read per precondition kind; the same reader serves building and validation. */
function readOperatorFact(
  context: OperatorContext,
  kind: OperatorPreconditionKind,
  entityIds: string[]
): OperatorFact {
  const [first = "", second = ""] = entityIds;
  switch (kind) {
    case "concept-exists":
      return conceptOf(context, first) !== undefined;
    case "current-package":
      return conceptOf(context, first)?.package ?? null;
    case "package-exists":
      return packageOf(context, first) !== undefined;
    case "boundary-exists":
      return context.projection.lookup.boundaryById.has(first);
    case "anchor-state":
      return packageOf(context, first)?.anchored ?? null;
    case "public-surface-state":
      return packageOf(context, first)?.surface?.packagePublicSymbols ?? null;
    case "external-usage-state": {
      const concept = conceptOf(context, first);
      if (concept?.distribution === undefined) {
        return null;
      }
      return sorted(
        concept.distribution.packages.filter((p) => p !== concept.package)
      );
    }
    case "behavior-center-state": {
      const scenario = context.scenarios.get(first);
      if (scenario !== undefined) {
        return placementPackages(scenario.scenario.current, "domain-behavior");
      }
      const concept = conceptOf(context, first);
      if (concept?.locality === undefined) {
        return null;
      }
      return sorted(
        concept.locality.behavior
          .filter((row) => row.sourceBehaviors > 0)
          .map((row) => row.package)
      );
    }
    case "implementation-state": {
      const concept = conceptOf(context, first);
      if (concept?.ownership === undefined) {
        return null;
      }
      return sorted(
        concept.ownership.participation
          .filter((row) => row.implementations > 0)
          .map((row) => row.package)
      );
    }
    case "distinct-placement":
      return first !== second;
    default:
      throw new Error("Unexpected kind.");
  }
}

function factKey(kind: OperatorPreconditionKind, entityIds: string[]): string {
  return `${kind}:${entityIds.join(",")}`;
}

function factLine(
  kind: OperatorPreconditionKind,
  entityIds: string[],
  value: OperatorFact
): string {
  return `${factKey(kind, entityIds)}=${JSON.stringify(value)}`;
}

export function operatorFingerprint(facts: string[]): OperatorFingerprint {
  const canonicalFacts = [...facts].sort(byId);
  return {
    facts: canonicalFacts,
    hash: createHash("sha256")
      .update(JSON.stringify(canonicalFacts))
      .digest("hex")
      .slice(0, 16),
  };
}

function sameFact(a: OperatorFact, b: OperatorFact): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Canonical assembly

function subjectId(subject: OperatorSubject): string {
  switch (subject.kind) {
    case "symbol":
      return subject.symbolId;
    case "concept":
    case "behavior":
      return subject.conceptId;
    case "package":
      return subject.packageId;
    case "boundary":
      return subject.boundaryId;
    default:
      throw new Error("Unexpected subject.kind.");
  }
}

function ref(
  source: OperatorEvidenceRef["source"],
  ...entityIds: string[]
): OperatorEvidenceRef {
  return { entityIds: sorted(entityIds), source };
}

function sortRefs(refs: OperatorEvidenceRef[]): OperatorEvidenceRef[] {
  const unique = new Map(
    refs.map((r) => [`${r.source}:${r.entityIds.join(",")}`, r])
  );
  return [...unique.values()].sort(
    (a, b) =>
      byId(a.source, b.source) ||
      byId(a.entityIds.join(","), b.entityIds.join(","))
  );
}

/**
 * Existence and distinctness are declared, not observed: an operator always
 * assumes its entities exist (a vanished entity reads as stale) and that its
 * placement changes something (a no-op reads as unsupported).
 */
const DECLARED_TRUE = new Set<OperatorPreconditionKind>([
  "concept-exists",
  "package-exists",
  "boundary-exists",
  "distinct-placement",
]);

function precondition(
  context: OperatorContext,
  kind: OperatorPreconditionKind,
  entityIds: string[],
  evidenceRefs: OperatorEvidenceRef[],
  expected?: OperatorFact
): OperatorPrecondition {
  return {
    entityIds,
    evidenceRefs: sortRefs(evidenceRefs),
    expected:
      expected ??
      (DECLARED_TRUE.has(kind)
        ? true
        : readOperatorFact(context, kind, entityIds)),
    kind,
  };
}

function requireConcept(
  context: OperatorContext,
  id: string
): WorkspaceConcept {
  const concept = conceptOf(context, id);
  if (concept === undefined) {
    throw new Error(
      `Unknown concept ${id}; operators take canonical concept ids`
    );
  }
  return concept;
}

function requirePackage(
  context: OperatorContext,
  id: string
): WorkspacePackage {
  const pkg = packageOf(context, id);
  if (pkg === undefined) {
    throw new Error(
      `Unknown package ${id}; operators take canonical package ids`
    );
  }
  return pkg;
}

function requireBoundary(context: OperatorContext, id: string): void {
  if (!context.projection.lookup.boundaryById.has(id)) {
    throw new Error(
      `Unknown boundary ${id}; operators take canonical boundary ids`
    );
  }
}

interface OperatorParts {
  constraints: OperatorConstraint[];
  evidence: OperatorEvidenceRef[];
  expectedEffects: OperatorExpectedEffect[];
  intent: OperatorIntent;
  kind: ArchitecturalOperatorKind;
  placement: OperatorPlacement;
  preconditions: OperatorPrecondition[];
  preservations: OperatorPreservation[];
  subject: OperatorSubject;
  verification: OperatorVerificationRequirement[];
}

function operatorId(parts: OperatorParts): string {
  const base = `operator:${parts.kind}:${subjectId(parts.subject)}`;
  const current = parts.placement.current?.package;
  const target = parts.placement.target?.package;
  if (current === undefined && target === undefined) {
    return base;
  }
  return `${base}:${current ?? ""}→${target ?? ""}`;
}

function canonical(
  parts: OperatorParts
): Omit<ArchitecturalOperator, "fingerprint" | "status"> {
  const preconditions = [...parts.preconditions].sort(
    (a, b) =>
      byId(a.kind, b.kind) || byId(a.entityIds.join(","), b.entityIds.join(","))
  );
  const preservations = [...parts.preservations]
    .map((p) => ({ ...p, entityIds: sorted(p.entityIds) }))
    .sort(
      (a, b) =>
        byId(a.kind, b.kind) ||
        byId(a.entityIds.join(","), b.entityIds.join(","))
    );
  const expectedEffects = [...parts.expectedEffects]
    .map((e) => ({ ...e, evidenceRefs: sortRefs(e.evidenceRefs) }))
    .sort(
      (a, b) =>
        byId(a.dimension, b.dimension) ||
        byId(a.change, b.change) ||
        byId(JSON.stringify(a.from ?? null), JSON.stringify(b.from ?? null)) ||
        byId(JSON.stringify(a.to ?? null), JSON.stringify(b.to ?? null))
    );
  const constraints = [...parts.constraints]
    .map((c) => ({ ...c, entityIds: sorted(c.entityIds) }))
    .sort(
      (a, b) =>
        byId(a.kind, b.kind) ||
        byId(a.entityIds.join(","), b.entityIds.join(","))
    );
  const verificationSteps = [...parts.verification].sort(
    (a, b) =>
      byId(a.kind, b.kind) ||
      byId(JSON.stringify(a.expected), JSON.stringify(b.expected))
  );
  return {
    constraints,
    evidence: sortRefs(parts.evidence),
    expectedEffects,
    id: operatorId(parts),
    intent: parts.intent,
    kind: parts.kind,
    placement: parts.placement,
    preconditions,
    preservations,
    schemaVersion: OPERATOR_SCHEMA_VERSION,
    subject: parts.subject,
    verification: verificationSteps,
  };
}

function assemble(
  context: OperatorContext,
  parts: OperatorParts
): ArchitecturalOperator {
  const body = canonical(parts);
  const fingerprint = operatorFingerprint(
    body.preconditions.map((p) => factLine(p.kind, p.entityIds, p.expected))
  );
  const draft: ArchitecturalOperator = {
    ...body,
    fingerprint,
    status: "draft",
  };
  const { status } = validateArchitecturalOperator(draft, context);
  return { ...draft, status: status === "stale" ? "draft" : status };
}

// ---------------------------------------------------------------------------
// Shared constraint and verification derivation

function anchorConstraint(
  pkg: WorkspacePackage | undefined,
  effect: OperatorConstraint["effect"],
  detail: string
): OperatorConstraint[] {
  if (pkg?.anchored !== true) {
    return [];
  }
  const reason = pkg.anchorReason === undefined ? "" : `: ${pkg.anchorReason}`;
  return [
    {
      detail: `${detail}${reason}`,
      effect,
      entityIds: [pkg.id],
      kind: "anchor",
    },
  ];
}

function coverageConstraint(
  context: OperatorContext,
  involved: string[],
  blockingWhenUnanalyzed: boolean
): OperatorConstraint[] {
  const { coverage } = context.projection.workspace.ingestion;
  if (coverage.complete) {
    return [];
  }
  const unanalyzed = sorted(
    involved.filter((id) => packageOf(context, id)?.analyzed !== true)
  );
  let effect: "informational" | "blocking" | "constraining";
  if (unanalyzed.length === 0) {
    effect = "informational";
  } else if (blockingWhenUnanalyzed) {
    effect = "blocking";
  } else {
    effect = "constraining";
  }
  const detail =
    unanalyzed.length === 0
      ? `workspace coverage is partial (${coverage.packagesAnalyzed} of ${coverage.packagesKnown} packages analyzed)`
      : `workspace coverage is partial; ${unanalyzed.join(", ")} not analyzed`;
  return [
    { detail, effect, entityIds: unanalyzed, kind: "coverage-incomplete" },
  ];
}

/** Interface or type concepts with no observed implementation anywhere may conform structurally, unseen by the analyzer. */
function conformanceConstraint(
  concept: WorkspaceConcept | undefined,
  effect: OperatorConstraint["effect"]
): OperatorConstraint[] {
  if (concept === undefined) {
    return [];
  }
  if (concept.kind !== "interface" && concept.kind !== "type") {
    return [];
  }
  const implementations =
    concept.ownership?.participation.reduce(
      (sum, row) => sum + row.implementations,
      0
    ) ?? 0;
  if (implementations > 0) {
    return [];
  }
  return [
    {
      detail: `${concept.name} is a ${concept.kind} with no observed implementation; object-literal conformance may be unseen`,
      effect,
      entityIds: [concept.id],
      kind: "structural-conformance-unknown",
    },
  ];
}

function verification(
  kind: ArchitecturalOperatorKind,
  expected: Partial<
    Record<OperatorVerificationRequirement["kind"], OperatorFact>
  >
): OperatorVerificationRequirement[] {
  return getOperatorDefinition(kind).verificationKinds.map((check) => ({
    expected: expected[check] ?? true,
    kind: check,
  }));
}

function consumersOf(concept: WorkspaceConcept | undefined): string[] {
  if (concept?.distribution === undefined) {
    return [];
  }
  return sorted(
    concept.distribution.packages.filter((p) => p !== concept.package)
  );
}

function intentOf(
  source: OperatorIntent["source"],
  reason: string,
  extra: Partial<OperatorIntent> = {}
): OperatorIntent {
  return { reason, source, ...extra };
}

// ---------------------------------------------------------------------------
// Builders

export interface RehomeConceptInput {
  conceptId: string;
  reason?: string;
  to: string;
}

export function createRehomeConceptOperator(
  context: OperatorContext,
  input: RehomeConceptInput
): ArchitecturalOperator {
  const concept = requireConcept(context, input.conceptId);
  requirePackage(context, input.to);
  const current = concept.package;
  const consumers = consumersOf(concept);
  const conceptRef = ref("concept", input.conceptId);
  return assemble(context, {
    constraints: [
      ...anchorConstraint(
        packageOf(context, current),
        "blocking",
        `semantic center would leave anchored package ${current}`
      ),
      ...anchorConstraint(
        packageOf(context, input.to),
        "constraining",
        `anchored package ${input.to} would gain the semantic contract`
      ),
      ...(consumers.length > 0
        ? [
            {
              detail: `${current} exposes the concept to ${consumers.join(", ")}; the public contract relocates`,
              effect: "constraining" as const,
              entityIds: [current],
              kind: "public-contract" as const,
            },
          ]
        : []),
      ...conformanceConstraint(concept, "blocking"),
      ...coverageConstraint(context, [current, input.to], true),
    ],
    evidence: [conceptRef, ref("workspace", current, input.to)],
    expectedEffects: [
      {
        certainty: "certain",
        change: "semantic-center-change",
        dimension: "ownership",
        evidenceRefs: [conceptRef],
        from: current,
        to: input.to,
      },
      {
        certainty: "conditional",
        change: "surface-relocation",
        dimension: "surface",
        evidenceRefs: [conceptRef],
        from: [current],
        to: [input.to],
      },
    ],
    intent: intentOf(
      "manual",
      input.reason ??
        `semantic center of ${input.conceptId} moves from ${current} to ${input.to}`
    ),
    kind: "rehome-concept",
    placement: { current: { package: current }, target: { package: input.to } },
    preconditions: [
      precondition(context, "concept-exists", [input.conceptId], [conceptRef]),
      precondition(context, "current-package", [input.conceptId], [conceptRef]),
      precondition(
        context,
        "package-exists",
        [input.to],
        [ref("workspace", input.to)]
      ),
      precondition(
        context,
        "anchor-state",
        [current],
        [ref("anchor", current)]
      ),
      precondition(
        context,
        "anchor-state",
        [input.to],
        [ref("anchor", input.to)]
      ),
      precondition(
        context,
        "external-usage-state",
        [input.conceptId],
        [conceptRef]
      ),
      precondition(
        context,
        "implementation-state",
        [input.conceptId],
        [conceptRef]
      ),
      precondition(context, "distinct-placement", [current, input.to], []),
    ],
    preservations: [
      { entityIds: [input.conceptId], kind: "runtime-behavior" },
      ...(consumers.length > 0
        ? [
            {
              entityIds: consumers,
              kind: "consumer-import-path" as const,
              reason: "consumers keep referencing the concept where they are",
            },
          ]
        : []),
    ],
    subject: { conceptId: input.conceptId, kind: "concept" },
    verification: verification("rehome-concept", {
      "anchor-preserved": sorted([current, input.to]),
      "concept-center": [input.conceptId, input.to],
      "public-surface": [input.to, "exposes"],
    }),
  });
}

export interface RehomeBehaviorInput {
  conceptId: string;
  from: string[];
  reason?: string;
  to: string;
}

export function createRehomeBehaviorOperator(
  context: OperatorContext,
  input: RehomeBehaviorInput
): ArchitecturalOperator {
  const concept = requireConcept(context, input.conceptId);
  requirePackage(context, input.to);
  const semanticCenter = concept.package;
  const from = sorted(input.from);
  const consumers = consumersOf(concept);
  const conceptRef = ref("concept", input.conceptId);
  return assemble(context, {
    constraints: [
      ...from.flatMap((pkg) =>
        anchorConstraint(
          packageOf(context, pkg),
          "constraining",
          `anchored package ${pkg} would lose domain behavior`
        )
      ),
      ...anchorConstraint(
        packageOf(context, input.to),
        "constraining",
        `anchored package ${input.to} would gain domain behavior`
      ),
      ...conformanceConstraint(concept, "constraining"),
      ...coverageConstraint(context, [...from, input.to], false),
    ],
    evidence: [conceptRef, ref("workspace", ...from, input.to)],
    expectedEffects: [
      {
        certainty: "conditional",
        change: "behavior-consolidation",
        dimension: "behavior",
        evidenceRefs: [conceptRef],
        from,
        to: [input.to],
      },
    ],
    intent: intentOf(
      "manual",
      input.reason ??
        `behavior of ${input.conceptId} in ${from.join(", ")} consolidates toward ${input.to}`
    ),
    kind: "rehome-behavior",
    placement: {
      current: { package: from.join(",") },
      target: { package: input.to },
    },
    preconditions: [
      precondition(context, "concept-exists", [input.conceptId], [conceptRef]),
      precondition(context, "current-package", [input.conceptId], [conceptRef]),
      precondition(
        context,
        "package-exists",
        [input.to],
        [ref("workspace", input.to)]
      ),
      precondition(
        context,
        "behavior-center-state",
        [input.conceptId],
        [conceptRef]
      ),
      ...from.map((pkg) =>
        precondition(context, "anchor-state", [pkg], [ref("anchor", pkg)])
      ),
      precondition(
        context,
        "anchor-state",
        [input.to],
        [ref("anchor", input.to)]
      ),
      precondition(
        context,
        "distinct-placement",
        [from.join(","), input.to],
        []
      ),
    ],
    preservations: [
      { entityIds: [semanticCenter], kind: "semantic-center" },
      { entityIds: [semanticCenter], kind: "public-contract" },
      ...(consumers.length > 0
        ? [{ entityIds: consumers, kind: "consumer-import-path" as const }]
        : []),
    ],
    subject: { conceptId: input.conceptId, kind: "behavior", packages: from },
    verification: verification("rehome-behavior", {
      "anchor-preserved": sorted([...from, input.to]),
      "behavior-location": [input.conceptId, input.to],
      "boundary-interaction": from
        .filter((pkg) => pkg !== input.to)
        .map((pkg) => boundaryIdOf(pkg, input.to)),
      "concept-center": [input.conceptId, semanticCenter],
    }),
  });
}

export interface RedirectDependencyInput {
  consumer: string;
  from: string;
  reason?: string;
  to: string;
}

export function createRedirectDependencyOperator(
  context: OperatorContext,
  input: RedirectDependencyInput
): ArchitecturalOperator {
  const boundaryId = boundaryIdOf(input.consumer, input.from);
  requireBoundary(context, boundaryId);
  requirePackage(context, input.to);
  const targetBoundary = boundaryIdOf(input.consumer, input.to);
  const boundaryRef = ref("workspace", boundaryId);
  return assemble(context, {
    constraints: [
      ...anchorConstraint(
        packageOf(context, input.to),
        "constraining",
        `anchored package ${input.to} would gain a consumer`
      ),
      ...coverageConstraint(
        context,
        [input.consumer, input.from, input.to],
        false
      ),
    ],
    evidence: [
      boundaryRef,
      ref("workspace", input.consumer, input.from, input.to),
    ],
    expectedEffects: [
      {
        certainty: "conditional",
        change: "dependency-redirect",
        dimension: "dependency",
        evidenceRefs: [boundaryRef],
        from: boundaryId,
        to: targetBoundary,
      },
      {
        certainty: "conditional",
        change: "boundary-redirect",
        dimension: "boundary",
        evidenceRefs: [boundaryRef],
        from: boundaryId,
        to: targetBoundary,
      },
    ],
    intent: intentOf(
      "manual",
      input.reason ??
        `${input.consumer} depends on ${input.to} instead of ${input.from}`
    ),
    kind: "redirect-dependency",
    placement: {
      current: { package: input.from },
      target: { package: input.to },
    },
    preconditions: [
      precondition(context, "boundary-exists", [boundaryId], [boundaryRef]),
      precondition(
        context,
        "package-exists",
        [input.consumer],
        [ref("workspace", input.consumer)]
      ),
      precondition(
        context,
        "package-exists",
        [input.to],
        [ref("workspace", input.to)]
      ),
      precondition(
        context,
        "anchor-state",
        [input.to],
        [ref("anchor", input.to)]
      ),
      precondition(context, "distinct-placement", [input.from, input.to], []),
    ],
    preservations: [
      { entityIds: [input.consumer], kind: "runtime-behavior" },
      { entityIds: [input.from], kind: "public-contract" },
    ],
    subject: {
      boundaryId,
      from: input.consumer,
      kind: "boundary",
      to: input.from,
    },
    verification: verification("redirect-dependency", {
      "anchor-preserved": sorted([input.consumer, input.from, input.to]),
      "boundary-interaction": [boundaryId, "reduced"],
      "dependency-edge": [targetBoundary, "present"],
    }),
  });
}

export interface PreserveBoundaryInput {
  packageId: string;
  reason: string;
}

export function createPreserveBoundaryOperator(
  context: OperatorContext,
  input: PreserveBoundaryInput
): ArchitecturalOperator {
  const pkg = requirePackage(context, input.packageId);
  const { anchorReason } = pkg;
  const { anchored } = pkg;
  return assemble(context, {
    constraints: [
      {
        detail: resolveDetail(anchored, input, anchorReason),
        effect: "informational",
        entityIds: [input.packageId],
        kind: "anchor",
      },
      ...coverageConstraint(context, [input.packageId], false),
    ],
    evidence: [
      ref("workspace", input.packageId),
      ref("anchor", input.packageId),
    ],
    expectedEffects: [],
    intent: intentOf("manual", input.reason),
    kind: "preserve-boundary",
    placement: {},
    preconditions: [
      precondition(
        context,
        "package-exists",
        [input.packageId],
        [ref("workspace", input.packageId)]
      ),
      precondition(
        context,
        "anchor-state",
        [input.packageId],
        [ref("anchor", input.packageId)]
      ),
    ],
    preservations: [
      { entityIds: [input.packageId], kind: "anchor", reason: input.reason },
      { entityIds: [input.packageId], kind: "public-contract" },
    ],
    subject: { kind: "package", packageId: input.packageId },
    verification: verification("preserve-boundary", {
      "anchor-preserved": [input.packageId],
      "dependency-edge": [input.packageId, "boundary-present"],
    }),
  });
}

type MoveSubject =
  | { kind: "concept"; conceptId: string }
  | { kind: "symbol"; symbolId: string; name: string; package: string };

export interface MoveInput {
  reason?: string;
  subject: MoveSubject;
  to: string;
}

function resolveDetail(
  anchored: boolean,
  input: PreserveBoundaryInput,
  anchorReason: string | undefined
): string {
  if (anchored) {
    return `${input.packageId} is anchored${anchorReason === undefined ? "" : `: ${anchorReason}`}`;
  }
  return `${input.packageId} is not anchored; this operator records the intent explicitly`;
}

export function createMoveOperator(
  context: OperatorContext,
  input: MoveInput
): ArchitecturalOperator {
  const concept =
    input.subject.kind === "concept"
      ? requireConcept(context, input.subject.conceptId)
      : undefined;
  const current =
    input.subject.kind === "concept"
      ? requireConcept(context, input.subject.conceptId).package
      : input.subject.package;
  requirePackage(context, current);
  requirePackage(context, input.to);
  const id =
    input.subject.kind === "concept"
      ? input.subject.conceptId
      : input.subject.symbolId;
  const subjectRef =
    input.subject.kind === "concept" ? ref("concept", id) : ref("surface", id);
  return assemble(context, {
    constraints: [
      ...anchorConstraint(
        packageOf(context, current),
        "constraining",
        `anchored package ${current} would lose ${id}`
      ),
      ...anchorConstraint(
        packageOf(context, input.to),
        "constraining",
        `anchored package ${input.to} would gain ${id}`
      ),
      ...conformanceConstraint(concept, "blocking"),
      ...coverageConstraint(context, [current, input.to], true),
    ],
    evidence: [subjectRef, ref("workspace", current, input.to)],
    expectedEffects: [
      {
        certainty: "conditional",
        change: "placement-change",
        dimension: input.subject.kind === "concept" ? "ownership" : "surface",
        evidenceRefs: [subjectRef],
        from: current,
        to: input.to,
      },
    ],
    intent: intentOf(
      "manual",
      input.reason ?? `${id} moves from ${current} to ${input.to}`
    ),
    kind: "move",
    placement: { current: { package: current }, target: { package: input.to } },
    preconditions: [
      ...(input.subject.kind === "concept"
        ? [
            precondition(context, "concept-exists", [id], [subjectRef]),
            precondition(context, "current-package", [id], [subjectRef]),
          ]
        : []),
      precondition(
        context,
        "package-exists",
        [current],
        [ref("workspace", current)]
      ),
      precondition(
        context,
        "package-exists",
        [input.to],
        [ref("workspace", input.to)]
      ),
      precondition(
        context,
        "anchor-state",
        [current],
        [ref("anchor", current)]
      ),
      precondition(
        context,
        "anchor-state",
        [input.to],
        [ref("anchor", input.to)]
      ),
      precondition(context, "distinct-placement", [current, input.to], []),
    ],
    preservations: [{ entityIds: [id], kind: "runtime-behavior" }],
    subject: input.subject,
    verification: verification("move", {
      "anchor-preserved": sorted([current, input.to]),
      "dependency-edge": [current, input.to],
    }),
  });
}

// ---------------------------------------------------------------------------
// Legacy internalize compatibility

function planStatus(
  status: InternalizeSymbolPlan["status"]
): ArchitecturalOperatorStatus {
  return status === "ready" ? "valid" : status;
}

/**
 * Represent a V3 internalize-symbol plan as an architectural operator. The
 * plan keeps its own fingerprint and mutation path; the operator points at
 * it and restates nothing about routes or edits.
 */
export function createInternalizeOperator(
  context: OperatorContext,
  planId: string
): ArchitecturalOperator {
  const entry = context.legacyPlansById.get(planId);
  if (entry === undefined) {
    throw new Error(
      `No internalize-symbol plan ${planId} in the operator context; pass the package reports to createOperatorContext`
    );
  }
  const { plan } = entry;
  const symbolRef = ref("surface", plan.subject.id);
  const publishable = plan.blockers.some((b) => b.reason === "publishable");
  const parts: OperatorParts = {
    constraints: publishable
      ? [
          {
            detail:
              "package appears independently publishable; consumers outside this repository are invisible",
            effect: "blocking",
            entityIds: [plan.target.package],
            kind: "public-contract",
          },
        ]
      : [],
    evidence: [symbolRef, ref("surface", plan.id)],
    expectedEffects: [
      {
        certainty: plan.status === "ready" ? "certain" : "conditional",
        change: "surface-internalization",
        dimension: "surface",
        evidenceRefs: [symbolRef],
        from: "package-public",
        to: "module-only",
      },
    ],
    intent: intentOf(
      "existing-plan",
      `${plan.subject.name} leaves the public surface of ${plan.target.package}`,
      { planId: plan.id }
    ),
    kind: "internalize",
    placement: { current: { package: plan.target.package } },
    preconditions: [
      {
        entityIds: [plan.subject.id],
        evidenceRefs: [symbolRef],
        expected: true,
        kind: "public-surface-state",
      },
      {
        entityIds: [plan.subject.id],
        evidenceRefs: [symbolRef],
        expected: [],
        kind: "external-usage-state",
      },
    ],
    preservations: [
      { entityIds: [plan.subject.id], kind: "runtime-behavior" },
      ...(packageOf(context, plan.target.package)?.anchored === true
        ? [{ entityIds: [plan.target.package], kind: "anchor" as const }]
        : []),
    ],
    subject: {
      kind: "symbol",
      name: plan.subject.name,
      package: plan.target.package,
      symbolId: plan.subject.id,
    },
    verification: verification("internalize", {
      "public-surface": [plan.subject.id, "module-only"],
    }),
  };
  const body = canonical(parts);
  return {
    ...body,
    fingerprint: { facts: [`plan:${plan.id}`], hash: plan.fingerprint },
    status: planStatus(plan.status),
  };
}

function validateInternalize(
  operator: ArchitecturalOperator,
  context: OperatorContext
): OperatorValidation {
  const planId = operator.intent.planId ?? "";
  const entry = context.legacyPlansById.get(planId);
  const report =
    entry === undefined
      ? undefined
      : context.reportsByPackage.get(entry.package);
  const base = {
    constraints: operator.constraints.map((c) => ({
      ...c,
      decisive: c.effect === "blocking",
    })),
    fingerprint: operator.fingerprint.hash,
    operatorId: operator.id,
  };
  if (entry === undefined || report === undefined) {
    return {
      ...base,
      cautions: [
        `internalize plan ${planId} is no longer derivable from the package reports`,
      ],
      preconditions: operator.preconditions.map((p) => ({
        ...p,
        actual: null,
        holds: false,
      })),
      status: "stale",
    };
  }
  const legacy = validateReductionPlan(entry.plan, report);
  // V3 facts are prose-keyed: "symbol still …" describe the public surface,
  // "external …" describe external usage. Each operator precondition holds
  // when every legacy fact of its family holds.
  const family = (kind: OperatorPreconditionKind) =>
    legacy.preconditions.filter((fact) =>
      kind === "public-surface-state"
        ? fact.fact.startsWith("symbol")
        : fact.fact.startsWith("external")
    );
  const preconditions: OperatorPreconditionResult[] =
    operator.preconditions.map((p) => {
      const holds = family(p.kind).every((f) => f.holds);
      return {
        ...p,
        actual: resolveActual(p, holds),
        holds,
      };
    });
  return {
    ...base,
    cautions: legacy.blockers.map((b) => `${b.reason}: ${b.detail}`),
    preconditions,
    status: legacy.status === "ready" ? "valid" : legacy.status,
    ...(legacy.currentFingerprint !== undefined && {
      currentFingerprint: legacy.currentFingerprint,
    }),
  };
}

// ---------------------------------------------------------------------------
// Scenario adapter

const CHANGE_DIMENSION: Partial<
  Record<ScenarioStructuralChangeKind, OperatorExpectedEffect["dimension"]>
> = {
  "behavior-center-change": "behavior",
  "behavior-consolidation": "behavior",
  "boundary-addition": "boundary",
  "boundary-elimination": "boundary",
  "boundary-reduction": "boundary",
  "dependency-addition": "dependency",
  "dependency-elimination": "dependency",
  "representation-boundary-added": "representation",
  "semantic-center-change": "ownership",
  "surface-relocation": "surface",
};

function resolveActual(
  p: OperatorPrecondition,
  holds: boolean
): boolean | never[] | null {
  if (p.kind === "public-surface-state") {
    return holds;
  }
  if (holds) {
    return [];
  }
  return null;
}

function effectsFromImpact(
  impact: ScenarioImpactAnalysis
): OperatorExpectedEffect[] {
  const impactRef = ref("impact", impact.scenarioId);
  const effects: OperatorExpectedEffect[] = [];
  for (const change of impact.changes) {
    const dimension = CHANGE_DIMENSION[change.kind];
    if (dimension === undefined) {
      continue;
    }
    effects.push({
      change: change.kind,
      dimension,
      ...(change.from !== undefined && { from: change.from }),
      ...(change.to !== undefined && { to: change.to }),
      certainty: change.certainty === "certain" ? "certain" : "conditional",
      evidenceRefs: [impactRef],
    });
  }
  const span = impact.impact.locality.sourcePackageCount;
  if (
    span.certainty !== "unknown" &&
    span.current !== null &&
    span.predicted !== null
  ) {
    effects.push({
      certainty: span.certainty === "certain" ? "certain" : "conditional",
      change: "source-package-span",
      dimension: "locality",
      evidenceRefs: [impactRef],
      from: span.current,
      to: span.predicted,
    });
  }
  return effects;
}

function preservationsFromImpact(
  impact: ScenarioImpactAnalysis
): OperatorPreservation[] {
  const vector = impact.impact;
  return impact.preserved.flatMap((entry): OperatorPreservation[] => {
    switch (entry.kind) {
      case "semantic-center":
        return [{ entityIds: [entry.detail], kind: "semantic-center" }];
      case "public-contract":
        return [{ entityIds: [entry.detail], kind: "public-contract" }];
      case "consumer-boundary":
        return [
          {
            entityIds: vector.surface.consumers.packages,
            kind: "consumer-import-path",
            reason: entry.detail,
          },
        ];
      case "implementation-split":
        return [
          {
            entityIds: vector.implementation.currentCenters,
            kind: "implementation-split",
          },
        ];
      case "persistence-boundary":
        return [
          {
            entityIds:
              vector.representation.persistenceRepresentationsPreserved,
            kind: "representation-boundary",
            reason: entry.detail,
          },
        ];
      case "anchor":
        return [{ entityIds: vector.intent.anchorsPreserved, kind: "anchor" }];
      default:
        throw new Error("Unexpected entry.kind.");
    }
  });
}

function scenarioConstraints(
  context: OperatorContext,
  source: OperatorScenarioSource,
  operatorKind: ArchitecturalOperatorKind,
  involved: string[]
): OperatorConstraint[] {
  const { scenario, impact } = source;
  const home = scenario.current.semanticCenter;
  const out: OperatorConstraint[] = [];
  for (const constraint of scenario.constraints) {
    switch (constraint.kind) {
      case "anchor":
        out.push({
          detail: constraint.reason,
          effect:
            scenario.status === "blocked" ||
            impact?.impact.intent.compatibility === "incompatible"
              ? "blocking"
              : "constraining",
          entityIds: [constraint.package],
          kind: "anchor",
        });
        break;
      case "public-contract":
        out.push({
          detail: `${constraint.package} exposes the concept package-publicly; the contract relocates`,
          effect: "constraining",
          entityIds: [constraint.package],
          kind: "public-contract",
        });
        break;
      case "representation-boundary":
        out.push({
          detail:
            "representation boundary with partner concepts must stay explicit",
          effect: "constraining",
          entityIds: constraint.concepts,
          kind: "representation-boundary",
        });
        break;
      case "structural-conformance-unknown":
        out.push({
          detail:
            "implementations may conform structurally, unseen by the analyzer",
          effect:
            operatorKind === "rehome-concept" ? "blocking" : "constraining",
          entityIds: [constraint.concept],
          kind: "structural-conformance-unknown",
        });
        break;
      default:
        throw new Error("Unexpected constraint.kind.");
    }
  }
  if (
    impact !== undefined &&
    scenario.constraints.every((c) => c.kind !== "anchor")
  ) {
    for (const pkg of impact.impact.intent.anchorsViolated) {
      out.push({
        detail: `semantic center would leave anchored package ${pkg}`,
        effect: "blocking",
        entityIds: [pkg],
        kind: "anchor",
      });
    }
    const touched = [
      ...impact.impact.intent.anchoredResponsibilitiesAdded,
      ...impact.impact.intent.anchoredResponsibilitiesRemoved,
    ];
    if (
      touched.length > 0 &&
      impact.impact.intent.anchorsViolated.length === 0
    ) {
      out.push({
        detail: `anchored responsibilities change: ${touched.join("; ")}`,
        effect: "constraining",
        entityIds: sorted(touched.map((t) => t.split(":")[0] ?? t)),
        kind: "anchor",
      });
    }
  }
  if (
    scenario.anchorContext.homeAnchored &&
    operatorKind === "rehome-concept" &&
    out.every((c) => c.kind !== "anchor")
  ) {
    out.push({
      detail: `semantic center would leave anchored package ${home}`,
      effect: "blocking",
      entityIds: [home],
      kind: "anchor",
    });
  }
  out.push(
    ...coverageConstraint(context, involved, operatorKind === "rehome-concept")
  );
  return out;
}

/**
 * Turn one explicitly selected V8.2 scenario into an operator. Expected
 * effects and preservations are the V8.3 impact's own `changes` and
 * `preserved`, never recomputed; the scenario, impact, and review ids stay
 * attached so the chain observation → reasoning → operation is auditable.
 */
export function createOperatorFromScenario(
  context: OperatorContext,
  scenarioId: string,
  options: { reason?: string } = {}
): OperatorFromScenarioResult {
  const source = context.scenarios.get(scenarioId);
  if (source === undefined) {
    const digest = context.projection.lookup.scenarioById.get(scenarioId);
    return {
      scenarioId,
      status: "unsupported",
      ...(digest !== undefined && { scenarioKind: digest.kind }),
      reason:
        digest === undefined
          ? `scenario ${scenarioId} is not in the workspace`
          : `scenario ${scenarioId} has no package-level record; pass the package reports to createOperatorContext`,
    };
  }
  const { scenario, impact, review } = source;
  const mapping = scenarioOperatorMapping(scenario.kind);
  if (mapping.operatorKind === null) {
    return {
      reason: mapping.gap ?? "no operator mapping",
      scenarioId,
      scenarioKind: scenario.kind,
      status: "unsupported",
    };
  }
  const conceptId = scenario.subject.id;
  const proposedCenter = scenario.proposed.semanticCenter;
  const missing = [
    ...(conceptOf(context, conceptId) === undefined ? [conceptId] : []),
    ...(packageOf(context, proposedCenter) === undefined
      ? [proposedCenter]
      : []),
  ];
  if (missing.length > 0) {
    return {
      reason: `scenario references entities the workspace does not know: ${missing.join(", ")}`,
      scenarioId,
      scenarioKind: scenario.kind,
      status: "unsupported",
    };
  }
  const conceptRef = ref("concept", conceptId);
  const {
    provenance,
    expectedEffects,
    intent,
  }: {
    provenance: OperatorEvidenceRef[];
    expectedEffects: OperatorExpectedEffect[];
    intent: OperatorIntent;
  } = collectProvenance(scenarioId, impact, review, options, scenario);
  let preservations: OperatorPreservation[];
  preservations = createOperatorFromScenarioEntries(impact, scenario);
  const evidence = [conceptRef, ...provenance];
  const anchorFacts = (pkgs: string[]) =>
    pkgs.map((pkg) =>
      precondition(context, "anchor-state", [pkg], [ref("anchor", pkg)])
    );

  if (mapping.operatorKind === "rehome-concept") {
    const current = scenario.current.semanticCenter;
    const target = scenario.proposed.semanticCenter;
    if (current === target) {
      return {
        reason: "scenario keeps the semantic center where it is (no-op)",
        scenarioId,
        scenarioKind: scenario.kind,
        status: "unsupported",
      };
    }
    const operator = assemble(context, {
      constraints: scenarioConstraints(context, source, "rehome-concept", [
        current,
        target,
      ]),
      evidence,
      expectedEffects,
      intent,
      kind: "rehome-concept",
      placement: { current: { package: current }, target: { package: target } },
      preconditions: [
        precondition(context, "concept-exists", [conceptId], [conceptRef]),
        precondition(
          context,
          "current-package",
          [conceptId],
          [conceptRef],
          current
        ),
        precondition(
          context,
          "package-exists",
          [target],
          [ref("workspace", target)]
        ),
        ...anchorFacts(sorted([current, target])),
        precondition(
          context,
          "external-usage-state",
          [conceptId],
          [conceptRef]
        ),
        precondition(
          context,
          "implementation-state",
          [conceptId],
          [conceptRef]
        ),
        precondition(context, "distinct-placement", [current, target], []),
      ],
      preservations,
      subject: { conceptId, kind: "concept" },
      verification: verification("rehome-concept", {
        "anchor-preserved": sorted([current, target]),
        "concept-center": [conceptId, target],
        "public-surface": [target, "exposes"],
      }),
    });
    return { operator, status: "created" };
  }

  const currentBehavior = placementPackages(
    scenario.current,
    "domain-behavior"
  );
  const proposedBehavior = placementPackages(
    scenario.proposed,
    "domain-behavior"
  );
  const from = currentBehavior.filter((pkg) => !proposedBehavior.includes(pkg));
  const [target] = proposedBehavior;
  if (
    from.length === 0 ||
    target === undefined ||
    proposedBehavior.length !== 1
  ) {
    return {
      reason:
        from.length === 0
          ? "scenario moves no domain behavior between packages (no-op)"
          : `scenario leaves domain behavior in ${proposedBehavior.join(", ")}; rehome-behavior needs one destination`,
      scenarioId,
      scenarioKind: scenario.kind,
      status: "unsupported",
    };
  }
  const { semanticCenter } = scenario.current;
  const operator = assemble(context, {
    constraints: scenarioConstraints(context, source, "rehome-behavior", [
      ...from,
      target,
    ]),
    evidence,
    expectedEffects,
    intent,
    kind: "rehome-behavior",
    placement: {
      current: { package: from.join(",") },
      target: { package: target },
    },
    preconditions: [
      precondition(context, "concept-exists", [conceptId], [conceptRef]),
      precondition(
        context,
        "current-package",
        [conceptId],
        [conceptRef],
        semanticCenter
      ),
      precondition(
        context,
        "package-exists",
        [target],
        [ref("workspace", target)]
      ),
      precondition(
        context,
        "behavior-center-state",
        [scenarioId],
        [ref("scenario", scenarioId)],
        currentBehavior
      ),
      precondition(context, "behavior-center-state", [conceptId], [conceptRef]),
      ...anchorFacts(sorted([...from, target])),
      precondition(context, "distinct-placement", [from.join(","), target], []),
    ],
    preservations,
    subject: { conceptId, kind: "behavior", packages: from },
    verification: verification("rehome-behavior", {
      "anchor-preserved": sorted([...from, target]),
      "behavior-location": [conceptId, target],
      "boundary-interaction": from
        .filter((pkg) => pkg !== target)
        .map((pkg) => boundaryIdOf(pkg, target)),
      "concept-center": [conceptId, semanticCenter],
    }),
  });
  return { operator, status: "created" };
}

function collectProvenance(
  scenarioId: string,
  impact: ScenarioImpactAnalysis | undefined,
  review: ArchitecturalScenarioReview | undefined,
  options: { reason?: string },
  scenario: RecenteringScenario
) {
  const provenance: OperatorEvidenceRef[] = [
    ref("scenario", scenarioId),
    ...(impact === undefined ? [] : [ref("impact", scenarioId)]),
    ...(review === undefined ? [] : [ref("review", review.findingId)]),
  ];
  const intent = intentOf(
    "architectural-review",
    options.reason ??
      `${scenario.kind} scenario selected from the ${review?.disposition ?? "unreviewed"} review of ${scenario.subject.name}`,
    {
      scenarioId,
      ...(review !== undefined && { reviewId: review.findingId }),
    }
  );
  const expectedEffects = impact === undefined ? [] : effectsFromImpact(impact);
  return { expectedEffects, intent, provenance };
}

function createOperatorFromScenarioEntries(
  impact: ScenarioImpactAnalysis | undefined,
  scenario: RecenteringScenario
): OperatorPreservation[] {
  let preservations: OperatorPreservation[];
  if (impact === undefined) {
    preservations = [
      ...(scenario.preservedResponsibilities.includes("semantic-contract")
        ? [
            {
              entityIds: [scenario.proposed.semanticCenter],
              kind: "semantic-center" as const,
            },
          ]
        : []),
    ];
  } else {
    preservations = preservationsFromImpact(impact);
  }
  return preservations;
}

// ---------------------------------------------------------------------------
// Validation

/**
 * Re-read every precondition against the current facts. A failed
 * precondition is `stale` (the facts moved), a failed no-op guard is
 * `unsupported`, a blocking constraint is `blocked`; otherwise `valid`.
 * Never executes anything and never re-analyzes a package.
 */
export function validateArchitecturalOperator(
  operator: ArchitecturalOperator,
  context: OperatorContext
): OperatorValidation {
  if (operator.kind === "internalize" && operator.intent.planId !== undefined) {
    return validateInternalize(operator, context);
  }
  const definition = getOperatorDefinition(operator.kind);
  const constraints = operator.constraints.map((c) => ({
    ...c,
    decisive: false,
  }));
  const cautions = operator.constraints
    .filter((c) => c.effect === "constraining")
    .map((c) => `${c.kind}: ${c.detail}`);
  const base = {
    fingerprint: operator.fingerprint.hash,
    operatorId: operator.id,
  };

  if (!definition.supportedSubjects.includes(operator.subject.kind)) {
    return {
      ...base,
      cautions: [
        `${operator.kind} does not support ${operator.subject.kind} subjects`,
      ],
      constraints,
      preconditions: [],
      status: "unsupported",
    };
  }

  const preconditions: OperatorPreconditionResult[] =
    operator.preconditions.map((p) => {
      const actual = readOperatorFact(context, p.kind, p.entityIds);
      return { ...p, actual, holds: sameFact(p.expected, actual) };
    });
  const resolvable = preconditions.every((p) => p.actual !== null);
  const currentFingerprint = resolvable
    ? operatorFingerprint(
        preconditions.map((p) => factLine(p.kind, p.entityIds, p.actual))
      ).hash
    : undefined;
  const withCurrent =
    currentFingerprint === undefined ? base : { ...base, currentFingerprint };

  const noop = preconditions.find(
    (p) => p.kind === "distinct-placement" && !p.holds
  );
  if (noop !== undefined) {
    return {
      ...withCurrent,
      cautions: ["current and target placement are identical (no-op)"],
      constraints,
      preconditions,
      status: "unsupported",
    };
  }
  const failed = preconditions.filter((p) => !p.holds);
  if (failed.length > 0) {
    return {
      ...withCurrent,
      cautions: failed.map(
        (p) =>
          `${p.kind} ${p.entityIds.join(",")}: expected ${JSON.stringify(p.expected)}, found ${JSON.stringify(p.actual)}`
      ),
      constraints,
      preconditions,
      status: "stale",
    };
  }
  const blocking = constraints.filter((c) => c.effect === "blocking");
  if (blocking.length > 0) {
    return {
      ...withCurrent,
      cautions: [...blocking.map((c) => `${c.kind}: ${c.detail}`), ...cautions],
      constraints: constraints.map((c) => ({
        ...c,
        decisive: c.effect === "blocking",
      })),
      preconditions,
      status: "blocked",
    };
  }
  return {
    ...withCurrent,
    cautions,
    constraints,
    preconditions,
    status: "valid",
  };
}

// ---------------------------------------------------------------------------
// Catalog helpers

/** Scenario kinds present in the workspace that no operator can express yet. */
export function operatorCatalogGaps(
  context: OperatorContext
): { scenarioKind: RecenteringScenarioKind; scenarios: number; gap: string }[] {
  const counts = new Map<RecenteringScenarioKind, number>();
  for (const scenario of context.projection.workspace.architecture.recentering
    .scenarios) {
    if (scenarioOperatorMapping(scenario.kind).operatorKind !== null) {
      continue;
    }
    counts.set(scenario.kind, (counts.get(scenario.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => byId(a[0], b[0]))
    .map(([scenarioKind, scenarios]) => ({
      gap: scenarioOperatorMapping(scenarioKind).gap ?? "no operator mapping",
      scenarioKind,
      scenarios,
    }));
}
