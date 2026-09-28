import { createHash } from "node:crypto";
import { validateArchitecturalOperator } from "./architectural-operator";
import {
  getOperatorDefinition,
  getStructuralActionDefinition,
  STRUCTURAL_ACTION_KINDS,
} from "./operator-catalog";
import type {
  ExpectedEffectCoverage,
  OperatorDecomposition,
  OperatorDecompositionGap,
  OperatorDecompositionGapKind,
  OperatorDecompositionStatus,
  OperatorDecompositionValidation,
  PreservationCoverage,
  StructuralAction,
  StructuralActionDependency,
  StructuralActionGroup,
  StructuralActionGroupKind,
  StructuralActionKind,
  StructuralActionPrecondition,
  StructuralActionStatus,
  StructuralActionSubject,
  StructuralLocation,
  VerificationCoverage,
} from "./operator-decomposition-types";
import { DECOMPOSITION_SCHEMA_VERSION } from "./operator-decomposition-types";
import type {
  ArchitecturalOperator,
  OperatorConstraint,
  OperatorContext,
  OperatorEvidenceRef,
  OperatorExpectedEffect,
  OperatorFact,
  OperatorPreconditionKind,
  OperatorPreservation,
  OperatorVerificationKind,
} from "./operator-types";
import { boundaryIdOf, byId, sorted } from "./workspace-projection";

// A decomposition reads the operator and the workspace facts the operator
// was built from. It partitions the operator's own effects, preservations,
// and verification contract across structural actions; it predicts nothing
// new, names no file, and orders nothing beyond explicit dependencies.

// ---------------------------------------------------------------------------
// Identity of operator parts (V11.0 assigned none)

export function preservationId(preservation: OperatorPreservation): string {
  return `${preservation.kind}:${preservation.entityIds.join(",")}`;
}

/** Operator effects in operator order; a repeated shape gets an ordinal. */
function effectIds(effects: OperatorExpectedEffect[]): string[] {
  const seen = new Map<string, number>();
  return effects.map((effect) => {
    const base = `${effect.dimension}:${effect.change}:${JSON.stringify(effect.from ?? null)}→${JSON.stringify(effect.to ?? null)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

export function subjectKey(subject: StructuralActionSubject): string {
  switch (subject.kind) {
    case "concept":
      return subject.conceptId;
    case "symbol":
      return subject.symbolId;
    case "behavior":
      return `${subject.conceptId}@${subject.role}`;
    case "boundary":
      return subject.conceptId === undefined
        ? subject.boundaryId
        : `${subject.boundaryId}#${subject.conceptId}`;
    case "exposure":
      return `${subject.package}#${subject.conceptId ?? subject.symbolId ?? "*"}`;
    case "dependency":
      return `${subject.consumer}⇢${subject.provider}#${subject.conceptId ?? "*"}`;
    case "package":
      return subject.packageId;
    default:
      throw new Error("Unexpected subject.kind.");
  }
}

function actionId(
  operatorId: string,
  kind: StructuralActionKind,
  subject: StructuralActionSubject,
  current?: StructuralLocation,
  target?: StructuralLocation
): string {
  const placement =
    current?.package === undefined && target?.package === undefined
      ? ""
      : `:${current?.package ?? "?"}→${target?.package ?? "?"}`;
  return `${operatorId}/${kind}:${subjectKey(subject)}${placement}`;
}

// ---------------------------------------------------------------------------
// Operator readers

function expected(
  operator: ArchitecturalOperator,
  kind: OperatorPreconditionKind,
  entityIds?: string[]
): OperatorFact | undefined {
  return operator.preconditions.find(
    (p) =>
      p.kind === kind &&
      (entityIds === undefined || p.entityIds.join(",") === entityIds.join(","))
  )?.expected;
}

function expectedList(
  operator: ArchitecturalOperator,
  kind: OperatorPreconditionKind,
  entityIds?: string[]
): string[] {
  const value = expected(operator, kind, entityIds);
  return Array.isArray(value) ? value : [];
}

function pre(
  operator: ArchitecturalOperator,
  kind: OperatorPreconditionKind,
  entityIds?: string[]
): StructuralActionPrecondition[] {
  return operator.preconditions
    .filter(
      (p) =>
        p.kind === kind &&
        (entityIds === undefined ||
          p.entityIds.join(",") === entityIds.join(","))
    )
    .map((p) => ({ entityIds: p.entityIds, kind: p.kind }));
}

function hasPreservation(
  operator: ArchitecturalOperator,
  kind: OperatorPreservation["kind"]
): OperatorPreservation | undefined {
  return operator.preservations.find((p) => p.kind === kind);
}

function conceptIdOf(operator: ArchitecturalOperator): string | undefined {
  const { subject } = operator;
  return subject.kind === "concept" || subject.kind === "behavior"
    ? subject.conceptId
    : undefined;
}

function currentPackages(operator: ArchitecturalOperator): string[] {
  const current = operator.placement.current?.package;
  return current === undefined ? [] : current.split(",");
}

function involvedPackages(operator: ArchitecturalOperator): string[] {
  const target = operator.placement.target?.package;
  let subjectPackages: string[];
  if (operator.subject.kind === "boundary") {
    subjectPackages = [operator.subject.from, operator.subject.to];
  } else if (operator.subject.kind === "package") {
    subjectPackages = [operator.subject.packageId];
  } else if (operator.subject.kind === "symbol") {
    subjectPackages = [operator.subject.package];
  } else {
    subjectPackages = [];
  }
  return sorted([
    ...currentPackages(operator),
    ...(target === undefined ? [] : [target]),
    ...subjectPackages,
  ]);
}

// ---------------------------------------------------------------------------
// Decomposition-relevant facts and fingerprint

function decompositionFacts(
  operator: ArchitecturalOperator,
  context: OperatorContext
): { facts: string[]; resolvable: boolean } {
  const { packages } = context.projection.workspace.packages;
  const facts = [
    `operator:${operator.id}`,
    `operator-fingerprint:${operator.fingerprint.hash}`,
    `coverage:complete=${String(context.projection.workspace.ingestion.coverage.complete)}`,
  ];
  let resolvable = true;
  for (const id of involvedPackages(operator)) {
    const pkg = packages.find((p) => p.id === id);
    if (pkg === undefined) {
      resolvable = false;
    }
    facts.push(`analyzed:${id}=${String(pkg?.analyzed ?? null)}`);
  }
  const conceptId = conceptIdOf(operator);
  if (conceptId !== undefined) {
    const concept = context.projection.lookup.conceptById.get(conceptId);
    if (concept === undefined) {
      resolvable = false;
    }
    const consumers =
      concept?.distribution === undefined
        ? null
        : sorted(
            concept.distribution.packages.filter((p) => p !== concept.package)
          );
    facts.push(`consumers:${conceptId}=${JSON.stringify(consumers)}`);
  }
  return { facts, resolvable };
}

function decompositionFingerprint(facts: string[]): {
  facts: string[];
  hash: string;
} {
  const canonical = [...facts].sort(byId);
  return {
    facts: canonical,
    hash: createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex")
      .slice(0, 16),
  };
}

// ---------------------------------------------------------------------------
// Assembly

interface ActionDraft {
  current?: StructuralLocation;
  evidence?: OperatorEvidenceRef[];
  kind: StructuralActionKind;
  preconditions?: StructuralActionPrecondition[];
  preserves?: string[];
  status?: StructuralActionStatus;
  subject: StructuralActionSubject;
  summary: string;
  target?: StructuralLocation;
}

class Assembly {
  readonly actions: StructuralAction[] = [];
  readonly dependencies: StructuralActionDependency[] = [];
  readonly gaps: OperatorDecompositionGap[] = [];

  private readonly operator: ArchitecturalOperator;
  constructor(operator: ArchitecturalOperator) {
    this.operator = operator;
  }

  add(draft: ActionDraft): StructuralAction {
    const id = actionId(
      this.operator.id,
      draft.kind,
      draft.subject,
      draft.current,
      draft.target
    );
    const existing = this.actions.find((a) => a.id === id);
    if (existing !== undefined) {
      return existing;
    }
    const action: StructuralAction = {
      id,
      kind: draft.kind,
      subject: draft.subject,
      ...(draft.current !== undefined && { current: draft.current }),
      ...(draft.target !== undefined && { target: draft.target }),
      evidence: draft.evidence ?? this.operator.evidence,
      expectedEffects: [],
      intent: {
        group: getStructuralActionDefinition(draft.kind).group,
        summary: draft.summary,
      },
      preconditions: draft.preconditions ?? [],
      preserves: sorted(draft.preserves ?? []),
      status: draft.status ?? "required",
    };
    this.actions.push(action);
    return action;
  }

  depend(
    before: StructuralAction,
    after: StructuralAction,
    kind: StructuralActionDependency["kind"],
    reason: string
  ): void {
    if (before.id === after.id) {
      return;
    }
    if (
      this.dependencies.some(
        (d) => d.before === before.id && d.after === after.id
      )
    ) {
      return;
    }
    this.dependencies.push({
      after: after.id,
      before: before.id,
      kind,
      reason,
    });
  }

  gap(
    kind: OperatorDecompositionGapKind,
    entities: string[],
    blocking: boolean,
    detail: string
  ): void {
    const ids = sorted(entities);
    if (
      this.gaps.some(
        (g) => g.kind === kind && g.entities.join(",") === ids.join(",")
      )
    ) {
      return;
    }
    this.gaps.push({ blocking, detail, entities: ids, kind });
  }

  byKind(kind: StructuralActionKind): StructuralAction[] {
    return this.actions.filter((a) => a.kind === kind);
  }
}

// ---------------------------------------------------------------------------
// Shared rules

function preservationActions(
  operator: ArchitecturalOperator,
  acc: Assembly,
  placement: StructuralAction[]
): void {
  const conceptId = conceptIdOf(operator);
  preservationActionsPreservation(operator, acc, conceptId, placement);
  // A representation constraint without a preservation still needs the boundary kept explicit.
  for (const constraint of operator.constraints) {
    if (constraint.kind !== "representation-boundary") {
      continue;
    }
    const action = acc.add({
      kind: "preserve-representation-boundary",
      subject: { conceptId: conceptId ?? "?", kind: "concept" },
      summary: `representation boundary with ${constraint.entityIds.join(", ")} stays explicit`,
    });
    for (const p of placement) {
      acc.depend(
        action,
        p,
        "preserve-before-remove",
        "the invariant is fixed before the placement changes"
      );
    }
  }
}

function preservationActionsPreservation(
  operator: ArchitecturalOperator,
  acc: Assembly,
  conceptId: string | undefined,
  placement: StructuralAction[]
) {
  for (const preservation of operator.preservations) {
    const id = preservationId(preservation);
    let action: StructuralAction | undefined;
    action = preservationActionsPreservationKind(
      preservation,
      action,
      acc,
      id,
      conceptId,
      operator,
      placement
    );
    if (action !== undefined) {
      for (const p of placement) {
        acc.depend(
          action,
          p,
          "preserve-before-remove",
          "the invariant is fixed before the placement changes"
        );
      }
    }
  }
}

function preservationActionsPreservationKind(
  preservation: OperatorPreservation,
  initialAction: StructuralAction | undefined,
  acc: Assembly,
  id: string,
  conceptId: string | undefined,
  operator: ArchitecturalOperator,
  placement: StructuralAction[]
) {
  let action = initialAction;
  switch (preservation.kind) {
    case "representation-boundary":
      action = acc.add({
        kind: "preserve-representation-boundary",
        preserves: [id],
        subject: { conceptId: conceptId ?? "?", kind: "concept" },
        summary: `representation boundary with ${preservation.entityIds.join(", ") || "partner representations"} stays explicit`,
      });
      break;
    case "implementation-split":
      action = acc.add({
        kind: "preserve-implementation-split",
        preconditions: pre(operator, "implementation-state"),
        preserves: [id],
        subject: {
          conceptId: conceptId ?? "?",
          kind: "behavior",
          role: "implementation",
        },
        summary: `implementations stay where they are: ${preservation.entityIds.join(", ")}`,
      });
      break;
    case "anchor":
      for (const packageId of preservation.entityIds) {
        action = acc.add({
          kind: "preserve-anchor-boundary",
          preconditions: pre(operator, "anchor-state", [packageId]),
          preserves: [id],
          subject: { kind: "package", packageId },
          summary: `${packageId} keeps its anchored boundary${preservation.reason === undefined ? "" : `: ${preservation.reason}`}`,
        });
        for (const p of placement) {
          acc.depend(action, p, "preserve-before-remove", "anchor holds");
        }
      }
      action = undefined;
      break;
    case "public-contract":
    case "semantic-center":
    case "consumer-import-path":
    case "runtime-behavior":
      break;
    default:
      throw new Error("Unexpected preservation.kind.");
  }
  return action;
}

function anchorActionsForBlockers(
  operator: ArchitecturalOperator,
  acc: Assembly,
  placement: StructuralAction[]
): void {
  for (const constraint of operator.constraints) {
    if (constraint.kind !== "anchor" || constraint.effect !== "blocking") {
      continue;
    }
    for (const packageId of constraint.entityIds) {
      const action = acc.add({
        kind: "preserve-anchor-boundary",
        preconditions: pre(operator, "anchor-state", [packageId]),
        subject: { kind: "package", packageId },
        summary: `${packageId} keeps its anchored boundary; ${constraint.detail}`,
      });
      for (const p of placement) {
        acc.depend(action, p, "preserve-before-remove", "anchor holds");
      }
    }
  }
}

function completenessGaps(
  operator: ArchitecturalOperator,
  acc: Assembly
): void {
  const conceptId = conceptIdOf(operator);
  for (const constraint of operator.constraints) {
    if (constraint.kind === "structural-conformance-unknown") {
      acc.gap(
        "structural-conformance-unknown",
        constraint.entityIds,
        false,
        constraint.detail
      );
      acc.gap(
        "behavior-members-unresolved",
        constraint.entityIds,
        true,
        "structural conformers may carry behavior the analyzer did not attribute to the concept"
      );
    }
    if (
      constraint.kind === "coverage-incomplete" &&
      (conceptId !== undefined || constraint.entityIds.length > 0)
    ) {
      acc.gap(
        "behavior-members-unresolved",
        resolveCompletenessGaps(constraint, conceptId),
        constraint.effect !== "informational",
        constraint.entityIds.length === 0
          ? `${constraint.detail}; participants in unanalyzed packages are unseen`
          : `${constraint.detail}; their participation is unseen`
      );
    }
  }
}

function resolveCompletenessGaps(
  constraint: OperatorConstraint,
  conceptId: string | undefined
): string[] {
  if (constraint.entityIds.length === 0) {
    if (conceptId === undefined) {
      return [];
    }
    return [conceptId];
  }
  return constraint.entityIds;
}

function targetModuleGap(acc: Assembly, placement: StructuralAction[]): void {
  for (const action of placement) {
    if (
      action.target?.package === undefined ||
      action.target.module !== undefined
    ) {
      continue;
    }
    acc.gap(
      "target-module-unresolved",
      [action.target.package],
      false,
      `the operator places into ${action.target.package} at package level; no module is selected`
    );
  }
}

// ---------------------------------------------------------------------------
// Per-kind rules

function decomposeRehomeConcept(
  operator: ArchitecturalOperator,
  acc: Assembly
): void {
  const conceptId = conceptIdOf(operator) ?? "?";
  const [current = "?"] = currentPackages(operator);
  const target = operator.placement.target?.package ?? "?";
  const consumers = expectedList(operator, "external-usage-state").filter(
    (p) => p !== target
  );
  const implementations = expectedList(operator, "implementation-state");
  const keepOldPath = hasPreservation(operator, "consumer-import-path");

  const relocate = acc.add({
    current: { package: current },
    kind: "relocate-semantic-declaration",
    preconditions: [
      ...pre(operator, "current-package"),
      ...pre(operator, "anchor-state", [current]),
      ...pre(operator, "anchor-state", [target]),
    ],
    subject: { conceptId, kind: "concept" },
    summary: `the semantic declaration of ${conceptId} is the responsibility of ${target}, not ${current}`,
    target: { package: target },
  });
  const establish = acc.add({
    kind: "establish-target-exposure",
    preconditions: pre(operator, "package-exists", [target]),
    subject: { conceptId, kind: "exposure", package: target },
    summary: `${target} exposes ${conceptId} package-publicly`,
    target: { package: target },
  });
  acc.depend(
    relocate,
    establish,
    "requires",
    "the target exposes what it now declares"
  );

  if (keepOldPath !== undefined) {
    const preserve = acc.add({
      current: { package: current },
      kind: "preserve-public-exposure",
      preconditions: pre(operator, "external-usage-state"),
      preserves: [
        preservationId(keepOldPath),
        ...operator.preservations
          .filter(
            (p) => p.kind === "public-contract" && p.entityIds.includes(current)
          )
          .map(preservationId),
      ],
      subject: { conceptId, kind: "exposure", package: current },
      summary: `${current} keeps exposing ${conceptId} for ${keepOldPath.entityIds.join(", ")}`,
    });
    acc.depend(
      establish,
      preserve,
      "requires",
      "the old exposure can only forward to a target that exposes the concept"
    );
  } else if (consumers.length > 0) {
    acc.gap(
      "surface-transition-unspecified",
      [current],
      false,
      `${consumers.join(", ")} import ${conceptId} from ${current}; the operator does not say whether the old path stays, forwards, or breaks`
    );
  }

  for (const consumer of consumers) {
    const redirect = acc.add({
      current: { package: current },
      kind: "redirect-concept-dependency",
      preconditions: pre(operator, "external-usage-state"),
      status: "conditional",
      subject: { conceptId, consumer, kind: "dependency", provider: current },
      summary: `${consumer} depends on ${target} for ${conceptId} instead of ${current}`,
      target: { package: target },
    });
    acc.depend(
      establish,
      redirect,
      "requires",
      "consumers can only depend on an exposed contract"
    );
  }
  // What stays behind (implementations, behavior) now depends on the new home.
  const staysBehind =
    implementations.includes(current) ||
    operator.expectedEffects.some(
      (e) =>
        e.change.endsWith("-addition") &&
        edgeOf(e) === boundaryIdOf(current, target)
    );
  if (staysBehind) {
    const inward = acc.add({
      current: { package: current },
      kind: "redirect-concept-dependency",
      preconditions: pre(operator, "implementation-state"),
      status: "conditional",
      subject: {
        conceptId,
        consumer: current,
        kind: "dependency",
        provider: target,
      },
      summary: `what remains of ${conceptId} in ${current} depends on ${target} for the declaration`,
      target: { package: target },
    });
    acc.depend(
      establish,
      inward,
      "requires",
      "the old home can only depend on an exposed contract"
    );
  }

  if (
    implementations.length > 1 &&
    hasPreservation(operator, "implementation-split") === undefined
  ) {
    const split = acc.add({
      kind: "preserve-implementation-split",
      preconditions: pre(operator, "implementation-state"),
      subject: { conceptId, kind: "behavior", role: "implementation" },
      summary: `implementations stay where they are: ${implementations.join(", ")}`,
    });
    acc.depend(
      split,
      relocate,
      "preserve-before-remove",
      "the invariant is fixed before the placement changes"
    );
  }
  preservationActions(operator, acc, [relocate]);
  anchorActionsForBlockers(operator, acc, [relocate]);
  targetModuleGap(acc, [relocate]);
  completenessGaps(operator, acc);
}

function decomposeRehomeBehavior(
  operator: ArchitecturalOperator,
  acc: Assembly
): void {
  const conceptId = conceptIdOf(operator) ?? "?";
  const from = currentPackages(operator);
  const target = operator.placement.target?.package ?? "?";
  const homeFact = expected(operator, "current-package");
  const home = typeof homeFact === "string" ? homeFact : target;
  const placement: StructuralAction[] = [];

  for (const source of from) {
    const relocate = acc.add({
      current: { package: source },
      kind: "relocate-behavior-responsibility",
      preconditions: [
        ...pre(operator, "behavior-center-state"),
        ...pre(operator, "anchor-state", [source]),
        ...pre(operator, "anchor-state", [target]),
      ],
      subject: { conceptId, kind: "behavior", role: "governing" },
      summary: `governing behavior of ${conceptId} in ${source} is the responsibility of ${target}`,
      target: { package: target },
    });
    placement.push(relocate);
    const redirect = acc.add({
      current: { package: source },
      kind: "redirect-concept-dependency",
      preconditions: pre(operator, "current-package"),
      status: "conditional",
      subject: {
        conceptId,
        consumer: source,
        kind: "dependency",
        provider: home,
      },
      summary:
        target === home
          ? `the governing behavior's dependency on ${home} for ${conceptId} becomes internal to ${home}; generic consumers in ${source} keep theirs`
          : `the governing behavior's dependency on ${home} for ${conceptId} is carried from ${source} to ${target}; generic consumers in ${source} keep theirs`,
      target: { package: target },
    });
    acc.depend(
      relocate,
      redirect,
      "requires",
      "the dependency follows the behavior"
    );
  }
  preservationActions(operator, acc, placement);
  anchorActionsForBlockers(operator, acc, placement);
  targetModuleGap(acc, placement);
  completenessGaps(operator, acc);
}

function decomposeRedirectDependency(
  operator: ArchitecturalOperator,
  acc: Assembly
): void {
  if (operator.subject.kind !== "boundary") {
    return;
  }
  const consumer = operator.subject.from;
  const provider = operator.subject.to;
  const target = operator.placement.target?.package ?? "?";
  const establish = acc.add({
    kind: "establish-target-exposure",
    preconditions: pre(operator, "package-exists", [target]),
    subject: { kind: "exposure", package: target },
    summary: `${target} exposes what ${consumer} needs from ${provider}`,
    target: { package: target },
  });
  const redirect = acc.add({
    current: { package: provider },
    kind: "redirect-concept-dependency",
    preconditions: [
      ...pre(operator, "boundary-exists"),
      ...pre(operator, "anchor-state", [target]),
    ],
    subject: { consumer, kind: "dependency", provider },
    summary: `${consumer} depends on ${target} instead of ${provider}; traffic to ${provider} that ${target} does not cover stays`,
    target: { package: target },
  });
  acc.depend(
    establish,
    redirect,
    "requires",
    "the consumer can only depend on an exposed contract"
  );
  acc.gap(
    "dependency-target-unresolved",
    [operator.subject.boundaryId],
    false,
    `the operator targets the whole ${operator.subject.boundaryId} boundary; which concepts ${target} must cover is not specified`
  );
  preservationActions(operator, acc, [redirect]);
  anchorActionsForBlockers(operator, acc, [redirect]);
  completenessGaps(operator, acc);
}

function decomposeInternalize(
  operator: ArchitecturalOperator,
  acc: Assembly
): void {
  if (operator.subject.kind !== "symbol") {
    return;
  }
  const { symbolId, package: packageId } = operator.subject;
  const internalize = acc.add({
    current: { package: packageId },
    kind: "internalize-old-exposure",
    preconditions: [
      ...pre(operator, "public-surface-state"),
      ...pre(operator, "external-usage-state"),
    ],
    subject: { kind: "exposure", package: packageId, symbolId },
    summary: `${operator.subject.name} leaves the public surface of ${packageId}; the declaration and its internal references stay`,
  });
  preservationActions(operator, acc, [internalize]);
  anchorActionsForBlockers(operator, acc, [internalize]);
}

function decomposePreserveBoundary(
  operator: ArchitecturalOperator,
  acc: Assembly
): void {
  if (operator.subject.kind !== "package") {
    return;
  }
  const { packageId } = operator.subject;
  acc.add({
    kind: "preserve-anchor-boundary",
    preconditions: pre(operator, "anchor-state", [packageId]),
    preserves: operator.preservations
      .filter((p) => p.entityIds.includes(packageId))
      .map(preservationId),
    subject: { kind: "package", packageId },
    summary: `${packageId} keeps its boundary: ${operator.intent.reason}`,
  });
}

// ---------------------------------------------------------------------------
// Effect partition

/** V8.3 labels edges `a → b`; boundary ids are `a→b`. One shape here. */
function edgeOf(effect: OperatorExpectedEffect): string | undefined {
  const value = effect.change.endsWith("-addition") ? effect.to : effect.from;
  if (typeof value !== "string" || !value.includes("→")) {
    return undefined;
  }
  const [from = "", to = ""] = value.split("→");
  return boundaryIdOf(from.trim(), to.trim());
}

function redirectsOn(
  acc: Assembly,
  edge: string,
  match: (
    subject: { consumer: string; provider: string },
    target: string | undefined,
    from: string,
    to: string
  ) => boolean
): StructuralAction[] {
  const [from = "", to = ""] = edge.split("→");
  return acc
    .byKind("redirect-concept-dependency")
    .filter(
      (a) =>
        a.subject.kind === "dependency" &&
        match(a.subject, a.target?.package, from, to)
    );
}

function effectTargets(
  operator: ArchitecturalOperator,
  effect: OperatorExpectedEffect,
  acc: Assembly
): StructuralAction[] {
  const placement = acc.actions.filter((a) => a.intent.group === "placement");
  switch (effect.change) {
    case "semantic-center-change":
      return acc.byKind("relocate-semantic-declaration");
    case "surface-relocation":
      return acc.byKind("establish-target-exposure");
    case "surface-internalization":
      return acc.byKind("internalize-old-exposure");
    case "behavior-center-change":
    case "behavior-consolidation":
      return acc.byKind("relocate-behavior-responsibility");
    case "source-package-span":
      return placement;
    case "dependency-redirect":
    case "boundary-redirect":
      return operator.kind === "redirect-dependency"
        ? acc.byKind("redirect-concept-dependency")
        : [];
    case "boundary-elimination":
    case "dependency-elimination": {
      const edge = edgeOf(effect);
      return edge === undefined
        ? []
        : acc
            .byKind("remove-boundary-participation")
            .filter(
              (a) =>
                a.subject.kind === "boundary" && a.subject.boundaryId === edge
            );
    }
    case "boundary-reduction": {
      const edge = edgeOf(effect);
      if (edge === undefined) {
        return [];
      }
      const redirects = redirectsOn(
        acc,
        edge,
        (s, _target, from, to) => s.consumer === from && s.provider === to
      );
      if (redirects.length > 0) {
        return redirects;
      }
      // The target stops importing the declaration it now owns.
      return acc
        .byKind("relocate-semantic-declaration")
        .filter(
          (a) =>
            boundaryIdOf(a.target?.package ?? "", a.current?.package ?? "") ===
            edge
        );
    }
    case "boundary-addition":
    case "dependency-addition": {
      const edge = edgeOf(effect);
      return edge === undefined
        ? []
        : redirectsOn(
            acc,
            edge,
            (s, target, from, to) =>
              (s.consumer === from && target === to) ||
              (target === from && s.provider === to)
          );
    }
    default:
      return [];
  }
}

/** Certain boundary eliminations become explicit removal actions; anything weaker stays a reduction on the redirect. */
function boundaryRemovalActions(
  operator: ArchitecturalOperator,
  acc: Assembly
): void {
  if (operator.kind !== "rehome-behavior") {
    return;
  }
  const conceptId = conceptIdOf(operator) ?? "?";
  for (const effect of operator.expectedEffects) {
    if (effect.change !== "boundary-elimination") {
      continue;
    }
    const edge = edgeOf(effect);
    if (edge === undefined) {
      continue;
    }
    const redirect = acc
      .byKind("redirect-concept-dependency")
      .find(
        (a) =>
          a.subject.kind === "dependency" &&
          boundaryIdOf(a.subject.consumer, a.subject.provider) === edge
      );
    if (redirect === undefined) {
      continue;
    }
    const remove = acc.add({
      current: { package: edge.split("→")[0] ?? edge },
      kind: "remove-boundary-participation",
      status: effect.certainty === "certain" ? "required" : "conditional",
      subject: { boundaryId: edge, conceptId, kind: "boundary" },
      summary: `${conceptId} stops crossing ${edge}; the edge carries nothing else`,
    });
    acc.depend(
      redirect,
      remove,
      "requires",
      "participation ends only after the dependency has moved"
    );
  }
}

/** Which gap an operator effect leaves when no action carries it; `undefined` is a rule defect validation reports. */
function unresolvedEffectGap(
  effect: OperatorExpectedEffect
): OperatorDecompositionGapKind | undefined {
  if (effect.dimension === "representation") {
    return "representation-strategy-unspecified";
  }
  if (effect.dimension === "boundary" || effect.dimension === "dependency") {
    return "dependency-target-unresolved";
  }
  return undefined;
}

function partitionEffects(
  operator: ArchitecturalOperator,
  acc: Assembly
): ExpectedEffectCoverage[] {
  const ids = effectIds(operator.expectedEffects);
  return operator.expectedEffects.map((effect, index) => {
    const targets = effectTargets(operator, effect, acc);
    for (const action of targets) {
      action.expectedEffects.push(effect);
    }
    const id = ids[index] ?? String(index);
    if (targets.length === 0) {
      const gap = unresolvedEffectGap(effect);
      if (gap !== undefined) {
        acc.gap(
          gap,
          edgeOf(effect) === undefined ? [] : [edgeOf(effect) ?? ""],
          false,
          gap === "representation-strategy-unspecified"
            ? `the operator expects ${effect.change}; no structural action realizes a representation change yet`
            : `the operator expects ${effect.change} on ${edgeOf(effect) ?? "an unnamed edge"}; no action of this decomposition carries that edge`
        );
      }
      return { actions: [], operatorEffectId: id, status: "unresolved" };
    }
    return {
      actions: sorted(targets.map((a) => a.id)),
      operatorEffectId: id,
      status: "covered",
    };
  });
}

function settleStatuses(operator: ArchitecturalOperator, acc: Assembly): void {
  for (const action of acc.actions) {
    if (
      action.status === "conditional" &&
      action.expectedEffects.some((e) => e.certainty === "certain")
    ) {
      action.status = "required";
    }
  }
  if (operator.status === "blocked") {
    for (const action of acc.actions) {
      if (action.intent.group !== "preservation") {
        action.status = "blocked";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Coverage

const CONFLICTS: Partial<
  Record<
    OperatorPreservation["kind"],
    (p: OperatorPreservation, a: StructuralAction) => boolean
  >
> = {
  anchor: () => true,
  "consumer-import-path": (_p, a) => a.kind === "relocate-semantic-declaration",
  "implementation-split": () => true,
  "public-contract": (p, a) =>
    (a.kind === "relocate-semantic-declaration" ||
      a.kind === "internalize-old-exposure") &&
    p.entityIds.includes(a.current?.package ?? ""),
  "representation-boundary": () => true,
  "semantic-center": (p, a) =>
    a.kind === "relocate-semantic-declaration" &&
    p.entityIds.includes(a.current?.package ?? ""),
};

function coverPreservations(
  operator: ArchitecturalOperator,
  actions: StructuralAction[]
): PreservationCoverage[] {
  return operator.preservations.map((preservation) => {
    const id = preservationId(preservation);
    const explicit = actions.filter((a) => a.preserves.includes(id));
    if (explicit.length > 0) {
      return {
        coveredByActions: sorted(explicit.map((a) => a.id)),
        preservationId: id,
        status: "covered",
      };
    }
    const conflict = CONFLICTS[preservation.kind];
    const conflicting =
      conflict === undefined
        ? false
        : actions.some((a) => conflict(preservation, a));
    return {
      coveredByActions: [],
      preservationId: id,
      status: conflicting ? "uncovered" : "implicit",
    };
  });
}

const VERIFY_ACTIONS: Record<OperatorVerificationKind, StructuralActionKind[]> =
  {
    "anchor-preserved": ["preserve-anchor-boundary"],
    "behavior-location": ["relocate-behavior-responsibility"],
    "boundary-interaction": [
      "redirect-concept-dependency",
      "remove-boundary-participation",
    ],
    "concept-center": [
      "relocate-semantic-declaration",
      "relocate-behavior-responsibility",
    ],
    "dependency-edge": [
      "redirect-concept-dependency",
      "remove-boundary-participation",
      "preserve-anchor-boundary",
    ],
    "public-surface": [
      "establish-target-exposure",
      "preserve-public-exposure",
      "internalize-old-exposure",
    ],
    tests: [],
    typecheck: [],
  };

export function coverVerification(
  operator: ArchitecturalOperator,
  actions: StructuralAction[]
): VerificationCoverage[] {
  const changes = actions.filter((a) => a.intent.group !== "preservation");
  const placement = actions.filter((a) => a.intent.group === "placement");
  return operator.verification.map((requirement) => {
    const kinds = VERIFY_ACTIONS[requirement.kind];
    let related =
      requirement.kind === "typecheck" || requirement.kind === "tests"
        ? changes
        : actions.filter((a) => kinds.includes(a.kind));
    if (related.length === 0 && requirement.kind === "anchor-preserved") {
      related =
        placement.length > 0
          ? placement
          : changes.filter((a) =>
              a.preconditions.some((p) => p.kind === "anchor-state")
            );
    }
    return {
      relatedActions: sorted(related.map((a) => a.id)),
      requirementId: requirement.kind,
      status: related.length === 0 ? "unresolved" : "covered",
    };
  });
}

// ---------------------------------------------------------------------------
// Graph

const GROUP_ORDER: StructuralActionGroupKind[] = [
  "preservation",
  "placement",
  "surface",
  "dependency",
  "verification",
];

/** Longest path from a root per action; actions on a cycle get no layer and are listed in `cycle`. */
export function layers(
  actions: StructuralAction[],
  dependencies: StructuralActionDependency[]
): { layer: Map<string, number>; cycle: string[] } {
  const indegree = new Map(actions.map((a) => [a.id, 0]));
  const out = new Map<string, string[]>(actions.map((a) => [a.id, []]));
  for (const d of dependencies) {
    if (!(indegree.has(d.before) && indegree.has(d.after))) {
      continue;
    }
    indegree.set(d.after, (indegree.get(d.after) ?? 0) + 1);
    out.get(d.before)?.push(d.after);
  }
  const layer = new Map<string, number>();
  const queue = actions
    .map((a) => a.id)
    .filter((id) => indegree.get(id) === 0)
    .sort(byId);
  for (const id of queue) {
    layer.set(id, 0);
  }
  while (queue.length > 0) {
    const id = queue.shift() ?? "";
    for (const next of out.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
      }
    }
  }
  const cycle = actions.map((a) => a.id).filter((id) => !layer.has(id));
  return { cycle: cycle.sort(byId), layer };
}

export function orderActions<T extends StructuralAction>(
  actions: T[],
  layer: Map<string, number>
): T[] {
  return [...actions].sort(
    (a, b) =>
      (layer.get(a.id) ?? 0) - (layer.get(b.id) ?? 0) ||
      GROUP_ORDER.indexOf(a.intent.group) -
        GROUP_ORDER.indexOf(b.intent.group) ||
      byId(a.kind, b.kind) ||
      byId(a.id, b.id)
  );
}

export function groupActions(
  actions: StructuralAction[]
): StructuralActionGroup[] {
  return GROUP_ORDER.flatMap((kind) => {
    const actionIds = actions
      .filter((a) => a.intent.group === kind)
      .map((a) => a.id);
    return actionIds.length === 0 ? [] : [{ actionIds, kind }];
  });
}

function canonicalAction(action: StructuralAction): StructuralAction {
  return {
    ...action,
    evidence: [...action.evidence].sort(
      (a, b) =>
        byId(a.source, b.source) ||
        byId(a.entityIds.join(","), b.entityIds.join(","))
    ),
    preconditions: [...action.preconditions].sort(
      (a, b) =>
        byId(a.kind, b.kind) ||
        byId(a.entityIds.join(","), b.entityIds.join(","))
    ),
  };
}

function sortDependencies(
  dependencies: StructuralActionDependency[]
): StructuralActionDependency[] {
  return [...dependencies].sort(
    (a, b) => byId(a.before, b.before) || byId(a.after, b.after)
  );
}

function sortGaps(
  gaps: OperatorDecompositionGap[]
): OperatorDecompositionGap[] {
  return [...gaps].sort(
    (a, b) =>
      byId(a.kind, b.kind) || byId(a.entities.join(","), b.entities.join(","))
  );
}

// ---------------------------------------------------------------------------
// Entry points

function emptyDecomposition(
  operator: ArchitecturalOperator,
  context: OperatorContext,
  status: OperatorDecompositionStatus,
  gaps: OperatorDecompositionGap[]
): OperatorDecomposition {
  const { facts } = decompositionFacts(operator, context);
  return {
    actions: [],
    dependencies: [],
    effectCoverage: [],
    fingerprint: decompositionFingerprint(facts),
    groups: [],
    operatorFingerprint: operator.fingerprint.hash,
    operatorId: operator.id,
    operatorKind: operator.kind,
    preservationCoverage: [],
    schemaVersion: DECOMPOSITION_SCHEMA_VERSION,
    status,
    unresolved: gaps,
    verificationCoverage: [],
  };
}

/**
 * Expand one operator into its structural actions. The operator is
 * validated first: a stale operator yields no actions (refresh it), an
 * unsupported one none, a blocked one the full set it would need with its
 * change actions marked blocked. Nothing here reads source or predicts
 * beyond the operator's own effects.
 */
export function decomposeArchitecturalOperator(
  operator: ArchitecturalOperator,
  context: OperatorContext
): OperatorDecomposition {
  const definition = getOperatorDefinition(operator.kind);
  if (definition.decomposition === "unsupported") {
    return emptyDecomposition(operator, context, "unsupported", [
      {
        blocking: true,
        detail: `${operator.kind} has no decomposition rules; unknown semantics are not decomposed as a generic move`,
        entities: [operator.kind],
        kind: "unsupported-action-kind",
      },
    ]);
  }
  const validation = validateArchitecturalOperator(operator, context);
  if (validation.status === "stale") {
    return emptyDecomposition(operator, context, "stale", []);
  }
  if (validation.status === "unsupported") {
    return emptyDecomposition(operator, context, "unsupported", [
      {
        blocking: true,
        detail: validation.cautions.join("; "),
        entities: [operator.kind],
        kind: "unsupported-action-kind",
      },
    ]);
  }
  const live: ArchitecturalOperator = {
    ...operator,
    status: validation.status,
  };
  const acc = new Assembly(live);
  switch (live.kind) {
    case "rehome-concept":
      decomposeRehomeConcept(live, acc);
      break;
    case "rehome-behavior":
      decomposeRehomeBehavior(live, acc);
      break;
    case "redirect-dependency":
      decomposeRedirectDependency(live, acc);
      break;
    case "internalize":
      decomposeInternalize(live, acc);
      break;
    case "preserve-boundary":
      decomposePreserveBoundary(live, acc);
      break;
    case "move":
      break;
    default:
      throw new Error("Unexpected live.kind.");
  }
  boundaryRemovalActions(live, acc);
  const effectCoverage = partitionEffects(live, acc);
  settleStatuses(live, acc);

  const { layer, cycle } = layers(acc.actions, acc.dependencies);
  if (cycle.length > 0) {
    return emptyDecomposition(operator, context, "unsupported", [
      {
        blocking: true,
        detail: "decomposition rules produced cyclic action requirements",
        entities: cycle,
        kind: "unsupported-action-kind",
      },
    ]);
  }
  const actions = orderActions(acc.actions, layer).map(canonicalAction);
  const gaps = sortGaps(acc.gaps);
  let status: OperatorDecompositionStatus;
  if (validation.status === "blocked") {
    status = "blocked";
  } else if (gaps.length > 0) {
    status = "partial";
  } else {
    status = "complete";
  }
  const { facts } = decompositionFacts(operator, context);
  return {
    actions,
    dependencies: sortDependencies(acc.dependencies),
    effectCoverage,
    fingerprint: decompositionFingerprint(facts),
    groups: groupActions(actions),
    operatorFingerprint: operator.fingerprint.hash,
    operatorId: operator.id,
    operatorKind: operator.kind,
    preservationCoverage: coverPreservations(live, actions),
    schemaVersion: DECOMPOSITION_SCHEMA_VERSION,
    status,
    unresolved: gaps,
    verificationCoverage: coverVerification(live, actions),
  };
}

const REQUIRED_ACTIONS: Partial<
  Record<ArchitecturalOperator["kind"], StructuralActionKind[]>
> = {
  internalize: ["internalize-old-exposure"],
  "preserve-boundary": ["preserve-anchor-boundary"],
  "redirect-dependency": ["redirect-concept-dependency"],
  "rehome-behavior": ["relocate-behavior-responsibility"],
  "rehome-concept": [
    "relocate-semantic-declaration",
    "establish-target-exposure",
  ],
};

/**
 * Check a decomposition against its operator and the current facts. Coverage
 * is recomputed from the actions, never trusted from the record. A changed
 * operator or workspace fact is `stale`; a structural defect is `invalid`.
 */
export function validateOperatorDecomposition(
  decomposition: OperatorDecomposition,
  operator: ArchitecturalOperator,
  context: OperatorContext
): OperatorDecompositionValidation {
  const problems: string[] = [];
  const { facts, resolvable } = decompositionFacts(operator, context);
  const currentFingerprint = resolvable
    ? decompositionFingerprint(facts).hash
    : undefined;
  const base = {
    fingerprint: decomposition.fingerprint.hash,
    operatorId: decomposition.operatorId,
    ...(currentFingerprint !== undefined && { currentFingerprint }),
  };
  const preservationCoverage = coverPreservations(
    operator,
    decomposition.actions
  );
  const verificationCoverage = coverVerification(
    operator,
    decomposition.actions
  );
  const ids = effectIds(operator.expectedEffects);
  const effectCoverage: ExpectedEffectCoverage[] = operator.expectedEffects.map(
    (effect, index) => {
      const id = ids[index] ?? String(index);
      const actions = decomposition.actions
        .filter((a) => a.expectedEffects.some((e) => sameEffect(e, effect)))
        .map((a) => a.id);
      return {
        actions: sorted(actions),
        operatorEffectId: id,
        status: actions.length === 0 ? "unresolved" : "covered",
      };
    }
  );
  const coverage = {
    effectCoverage,
    preservationCoverage,
    verificationCoverage,
  };

  if (decomposition.operatorId !== operator.id) {
    problems.push(
      `decomposition belongs to ${decomposition.operatorId}, not ${operator.id}`
    );
    return { ...base, cycles: [], problems, status: "invalid", ...coverage };
  }
  if (
    decomposition.operatorFingerprint !== operator.fingerprint.hash ||
    (currentFingerprint !== undefined &&
      currentFingerprint !== decomposition.fingerprint.hash)
  ) {
    problems.push(
      decomposition.operatorFingerprint === operator.fingerprint.hash
        ? "decomposition-relevant facts changed since the decomposition was built"
        : `operator fingerprint moved from ${decomposition.operatorFingerprint} to ${operator.fingerprint.hash}`
    );
    return { ...base, cycles: [], problems, status: "stale", ...coverage };
  }
  if (
    decomposition.status === "stale" ||
    decomposition.status === "unsupported"
  ) {
    return { ...base, cycles: [], problems, status: "valid", ...coverage };
  }

  const known = new Set<string>(STRUCTURAL_ACTION_KINDS);
  const actionIds = new Set(decomposition.actions.map((a) => a.id));
  const visitAction = () => {
    for (const action of decomposition.actions) {
      if (!known.has(action.kind)) {
        problems.push(`${action.id}: unknown action kind ${action.kind}`);
        continue;
      }
      const definition = getStructuralActionDefinition(action.kind);
      if (!definition.supportedSubjects.includes(action.subject.kind)) {
        problems.push(
          `${action.id}: ${action.kind} does not take ${action.subject.kind} subjects`
        );
      }
      if (definition.requiresTarget && action.target?.package === undefined) {
        problems.push(`${action.id}: ${action.kind} needs a target package`);
      }
    }
  };
  visitAction();
  validateOperatorDecompositionD(decomposition, actionIds, problems);
  const { cycle } = layers(decomposition.actions, decomposition.dependencies);
  const cycles = cycle.length === 0 ? [] : [cycle];
  if (cycle.length > 0) {
    problems.push(`actions form a cycle: ${cycle.join(", ")}`);
  }

  validateOperatorDecompositionKind(operator, decomposition, problems);
  for (const c of preservationCoverage) {
    if (c.status === "uncovered") {
      problems.push(`preservation ${c.preservationId} is not covered`);
    }
  }
  operator.expectedEffects.forEach((effect, index) => {
    const c = effectCoverage[index];
    if (c?.status !== "unresolved") {
      return;
    }
    const gap = unresolvedEffectGap(effect);
    const recorded =
      gap !== undefined && decomposition.unresolved.some((g) => g.kind === gap);
    if (!recorded) {
      problems.push(`expected effect ${c.operatorEffectId} has no action`);
    }
  });
  for (const c of verificationCoverage) {
    if (c.status === "unresolved") {
      problems.push(`verification ${c.requirementId} relates to no action`);
    }
  }

  return {
    ...base,
    cycles,
    problems,
    status: problems.length === 0 ? "valid" : "invalid",
    ...coverage,
  };
}

function validateOperatorDecompositionKind(
  operator: ArchitecturalOperator,
  decomposition: OperatorDecomposition,
  problems: string[]
) {
  for (const kind of REQUIRED_ACTIONS[operator.kind] ?? []) {
    if (!decomposition.actions.some((a) => a.kind === kind)) {
      problems.push(`${operator.kind} requires a ${kind} action`);
    }
  }
}

function validateOperatorDecompositionD(
  decomposition: OperatorDecomposition,
  actionIds: Set<string>,
  problems: string[]
) {
  for (const d of decomposition.dependencies) {
    if (!(actionIds.has(d.before) && actionIds.has(d.after))) {
      problems.push(
        `dependency ${d.before} → ${d.after} names an unknown action`
      );
    }
  }
}

export function sameEffect(
  a: OperatorExpectedEffect,
  b: OperatorExpectedEffect
): boolean {
  return (
    a.dimension === b.dimension &&
    a.change === b.change &&
    JSON.stringify(a.from ?? null) === JSON.stringify(b.from ?? null) &&
    JSON.stringify(a.to ?? null) === JSON.stringify(b.to ?? null)
  );
}
