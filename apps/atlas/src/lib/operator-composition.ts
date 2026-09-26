import { createHash } from "node:crypto";
import { validateArchitecturalOperator } from "./architectural-operator";
import type {
  ComposedActionDependency,
  ComposedStructuralAction,
  CompositionEffect,
  CompositionGapResolution,
  CompositionPreservation,
  CompositionVerification,
  OperatorComposition,
  OperatorCompositionConflict,
  OperatorCompositionConflictKind,
  OperatorCompositionGap,
  OperatorCompositionStatus,
  OperatorCompositionValidation,
  SharedStructuralAction,
  StructuralActionCanonicalKey,
} from "./operator-composition-types";
import {
  COMPOSITION_RULES_VERSION,
  COMPOSITION_SCHEMA_VERSION,
} from "./operator-composition-types";
import {
  coverVerification,
  decomposeArchitecturalOperator,
  groupActions,
  layers,
  orderActions,
  preservationId,
  sameEffect,
  subjectKey,
  validateOperatorDecomposition,
} from "./operator-decomposition";
import type {
  OperatorDecomposition,
  StructuralAction,
  StructuralActionDependency,
  StructuralActionDependencyKind,
  StructuralActionKind,
  StructuralActionStatus,
} from "./operator-decomposition-types";
import type {
  ArchitecturalOperator,
  OperatorContext,
  OperatorExpectedEffect,
} from "./operator-types";
import { byId, sorted } from "./workspace-projection";

// A composition reads operators, their decompositions, and the facts both
// were built from. It merges actions that name the same work, merges and
// infers dependencies, and reconciles preservations, effects, verification,
// and gaps across operators. It never picks between contradictory intents
// and never adds an action no decomposition asked for.

function uniq(values: string[]): string[] {
  return sorted([...new Set(values)]);
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const value of values) {
    if (!seen.has(key(value))) {
      seen.set(key(value), value);
    }
  }
  return [...seen.entries()]
    .sort((a, b) => byId(a[0], b[0]))
    .map(([, value]) => value);
}

function index<T>(
  values: T[],
  key: (value: T) => string | undefined
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const value of values) {
    const k = key(value);
    if (k === undefined) {
      continue;
    }
    const list = out.get(k);
    if (list === undefined) {
      out.set(k, [value]);
    } else {
      list.push(value);
    }
  }
  return out;
}

function hash16(facts: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(facts))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Canonical identity

export function canonicalActionKey(
  action: StructuralAction
): StructuralActionCanonicalKey {
  const current = action.current?.package;
  const target = action.target?.package;
  return {
    kind: action.kind,
    subject: subjectKey(action.subject),
    ...(current !== undefined && { current }),
    ...(target !== undefined && { target }),
  };
}

/** `<kind>:<subject>[:<current>→<target>]`: the action id without its operator. */
export function canonicalActionId(key: StructuralActionCanonicalKey): string {
  const placement =
    key.current === undefined && key.target === undefined
      ? ""
      : `:${key.current ?? "?"}→${key.target ?? "?"}`;
  return `${key.kind}:${key.subject}${placement}`;
}

function mergedId(canonical: string): string {
  return `composed/${canonical}`;
}

// ---------------------------------------------------------------------------
// Operator and action readers

function conceptOf(operator: ArchitecturalOperator): string | undefined {
  const { subject } = operator;
  return subject.kind === "concept" || subject.kind === "behavior"
    ? subject.conceptId
    : undefined;
}

function subjectIdOf(operator: ArchitecturalOperator): string {
  const { subject } = operator;
  switch (subject.kind) {
    case "concept":
    case "behavior":
      return subject.conceptId;
    case "symbol":
      return subject.symbolId;
    case "boundary":
      return subject.boundaryId;
    case "package":
      return subject.packageId;
  }
}

/** Where consumers reach the operator's concept today: the recorded current package. */
function homeOf(operator: ArchitecturalOperator): string | undefined {
  const fact = operator.preconditions.find(
    (p) => p.kind === "current-package"
  )?.expected;
  return typeof fact === "string" ? fact : operator.placement.current?.package;
}

function currentPackages(operator: ArchitecturalOperator): string[] {
  const current = operator.placement.current?.package;
  return current === undefined ? [] : current.split(",");
}

function packageOf(action: StructuralAction): string | undefined {
  const { subject } = action;
  return subject.kind === "exposure"
    ? subject.package
    : subject.kind === "package"
      ? subject.packageId
      : undefined;
}

function exposureId(action: StructuralAction): string | undefined {
  return action.subject.kind === "exposure"
    ? (action.subject.conceptId ?? action.subject.symbolId)
    : undefined;
}

/** Concept scopes agree when equal or when either side is the whole boundary. */
function compatible(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

function isPlacement(action: StructuralAction): boolean {
  return action.intent.group === "placement";
}

// ---------------------------------------------------------------------------
// Intake

interface Input {
  decomposition: OperatorDecomposition;
  operator: ArchitecturalOperator;
}

interface Intake {
  blocked: string[];
  inputs: Input[];
  problems: string[];
  redecomposed: string[];
  stale: string[];
  unsupported: string[];
}

/**
 * A stale operator is never redecomposed: the composition reports it. A
 * decomposition that is missing, behind its operator, or behind the facts
 * while the operator still validates is rebuilt here and listed as such.
 */
function intake(
  operators: ArchitecturalOperator[],
  decompositions: OperatorDecomposition[],
  context: OperatorContext
): Intake {
  const byOperator = new Map<string, ArchitecturalOperator>();
  for (const operator of operators) {
    const existing = byOperator.get(operator.id);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(operator)
    ) {
      throw new Error(`Two different operators share the id ${operator.id}`);
    }
    byOperator.set(operator.id, operator);
  }
  const records = new Map<string, OperatorDecomposition>();
  for (const record of decompositions) {
    const operator = byOperator.get(record.operatorId);
    if (operator === undefined) {
      continue;
    }
    const existing = records.get(record.operatorId);
    if (
      existing === undefined ||
      (existing.operatorFingerprint !== operator.fingerprint.hash &&
        record.operatorFingerprint === operator.fingerprint.hash)
    ) {
      records.set(record.operatorId, record);
    }
  }

  const out: Intake = {
    blocked: [],
    inputs: [],
    problems: [],
    redecomposed: [],
    stale: [],
    unsupported: [],
  };
  const sortedOperators = [...byOperator.values()].sort((a, b) =>
    byId(a.id, b.id)
  );
  for (const operator of sortedOperators) {
    const validation = validateArchitecturalOperator(operator, context);
    if (validation.status === "stale") {
      out.stale.push(operator.id);
      out.problems.push(
        `${operator.id}: operator is stale: ${validation.cautions.join("; ")}`
      );
    } else if (validation.status === "unsupported") {
      out.unsupported.push(operator.id);
      out.problems.push(
        `${operator.id}: operator is unsupported: ${validation.cautions.join("; ")}`
      );
    } else if (validation.status === "blocked") {
      out.blocked.push(operator.id);
      out.problems.push(
        `${operator.id}: operator is blocked: ${validation.cautions[0] ?? ""}`
      );
    }

    let decomposition = records.get(operator.id);
    if (validation.status === "stale") {
      // The record was built on facts that moved; only its absence is shown.
      decomposition = decomposeArchitecturalOperator(operator, context);
    } else {
      let behind: string | undefined;
      if (decomposition === undefined) {
        behind = "missing";
      } else if (
        decomposition.operatorFingerprint !== operator.fingerprint.hash
      ) {
        behind = "behind its operator";
      } else if (decomposition.status === "stale") {
        behind = "recorded stale";
      } else {
        const check = validateOperatorDecomposition(
          decomposition,
          operator,
          context
        );
        if (check.status === "stale") {
          behind = "facts moved";
        } else if (check.status === "invalid") {
          out.unsupported.push(operator.id);
          out.problems.push(
            `${operator.id}: decomposition is invalid: ${check.problems.join("; ")}`
          );
        }
      }
      if (behind !== undefined) {
        decomposition = decomposeArchitecturalOperator(operator, context);
        out.redecomposed.push(`${operator.id} (${behind})`);
      }
    }
    decomposition ??= decomposeArchitecturalOperator(operator, context);
    if (
      decomposition.status === "unsupported" &&
      !out.unsupported.includes(operator.id)
    ) {
      out.unsupported.push(operator.id);
      out.problems.push(
        `${operator.id}: no decomposition: ${decomposition.unresolved.map((g) => g.detail).join("; ")}`
      );
    }
    if (
      decomposition.status === "blocked" &&
      !out.blocked.includes(operator.id)
    ) {
      out.blocked.push(operator.id);
    }
    out.inputs.push({ decomposition, operator });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Action merge

export interface SourcedAction {
  action: StructuralAction;
  operatorId: string;
}

const STATUS_STRENGTH: Record<StructuralActionStatus, number> = {
  blocked: 0,
  conditional: 2,
  required: 1,
  unsupported: 3,
};

/**
 * One action from equivalent actions: preconditions, preserved invariants,
 * effects, and evidence are unions; the status is the strongest. The
 * first source (by action id) supplies the wording.
 */
export function mergeStructuralActions(
  id: string,
  sources: SourcedAction[]
): ComposedStructuralAction {
  const ordered = [...sources].sort((a, b) => byId(a.action.id, b.action.id));
  const [first] = ordered;
  if (first === undefined) {
    throw new Error("nothing to merge");
  }
  const effects: OperatorExpectedEffect[] = [];
  for (const { action } of ordered) {
    for (const effect of action.expectedEffects) {
      if (!effects.some((e) => sameEffect(e, effect))) {
        effects.push(effect);
      }
    }
  }
  const status = ordered
    .map((s) => s.action.status)
    .reduce((a, b) => (STATUS_STRENGTH[a] <= STATUS_STRENGTH[b] ? a : b));
  return {
    ...first.action,
    evidence: dedupeBy(
      ordered.flatMap((s) => s.action.evidence),
      (e) => `${e.source}:${e.entityIds.join(",")}`
    ),
    expectedEffects: effects,
    id,
    preconditions: dedupeBy(
      ordered.flatMap((s) => s.action.preconditions),
      (p) => `${p.kind}:${p.entityIds.join(",")}`
    ),
    preserves: uniq(ordered.flatMap((s) => s.action.preserves)),
    sourceActions: uniq(ordered.map((s) => s.action.id)),
    sourceOperators: uniq(ordered.map((s) => s.operatorId)),
    status,
  };
}

function mergeActions(inputs: Input[]): {
  actions: ComposedStructuralAction[];
  shared: SharedStructuralAction[];
  idMap: Map<string, string>;
  inputActions: number;
} {
  const byKey = new Map<string, SourcedAction[]>();
  let inputActions = 0;
  for (const { operator, decomposition } of inputs) {
    for (const action of decomposition.actions) {
      inputActions += 1;
      const key = canonicalActionId(canonicalActionKey(action));
      const list = byKey.get(key);
      const source = { action, operatorId: operator.id };
      if (list === undefined) {
        byKey.set(key, [source]);
      } else {
        list.push(source);
      }
    }
  }
  const actions: ComposedStructuralAction[] = [];
  const shared: SharedStructuralAction[] = [];
  const idMap = new Map<string, string>();
  for (const key of [...byKey.keys()].sort(byId)) {
    const sources = byKey.get(key) ?? [];
    const id = mergedId(key);
    const merged = mergeStructuralActions(id, sources);
    for (const source of sources) {
      idMap.set(source.action.id, id);
    }
    actions.push(merged);
    if (sources.length > 1) {
      shared.push({
        canonicalActionId: key,
        mergedActionId: id,
        sourceActions: merged.sourceActions,
        sourceOperators: merged.sourceOperators,
      });
    }
  }
  return { actions, idMap, inputActions, shared };
}

// ---------------------------------------------------------------------------
// Dependencies

function mergeDependencies(
  inputs: Input[],
  idMap: Map<string, string>
): ComposedActionDependency[] {
  const merged = new Map<
    string,
    {
      before: string;
      after: string;
      kinds: Set<StructuralActionDependencyKind>;
      reason: string;
      operators: Set<string>;
    }
  >();
  for (const { operator, decomposition } of inputs) {
    for (const d of decomposition.dependencies) {
      const before = idMap.get(d.before);
      const after = idMap.get(d.after);
      if (before === undefined || after === undefined || before === after) {
        continue;
      }
      const key = `${before} ${after}`;
      const entry = merged.get(key);
      if (entry === undefined) {
        merged.set(key, {
          after,
          before,
          kinds: new Set([d.kind]),
          operators: new Set([operator.id]),
          reason: d.reason,
        });
      } else {
        entry.kinds.add(d.kind);
        entry.operators.add(operator.id);
      }
    }
  }
  return [...merged.values()].map((e) => ({
    after: e.after,
    before: e.before,
    kind: [...e.kinds].sort(byId)[0] ?? "requires",
    origin: "explicit",
    reason: e.reason,
    sourceOperators: sorted([...e.operators]),
  }));
}

interface InferenceRule {
  edges: (
    actions: ComposedStructuralAction[]
  ) => [ComposedStructuralAction, ComposedStructuralAction][];
  id: string;
  kind: StructuralActionDependencyKind;
  reason: string;
}

function ofKind(
  actions: ComposedStructuralAction[],
  kind: StructuralActionKind
): ComposedStructuralAction[] {
  return actions.filter((a) => a.kind === kind);
}

function pairs(
  lefts: ComposedStructuralAction[],
  rightsBy: Map<string, ComposedStructuralAction[]>,
  key: (left: ComposedStructuralAction) => string | undefined,
  accept: (
    left: ComposedStructuralAction,
    right: ComposedStructuralAction
  ) => boolean
): [ComposedStructuralAction, ComposedStructuralAction][] {
  const out: [ComposedStructuralAction, ComposedStructuralAction][] = [];
  for (const left of lefts) {
    const k = key(left);
    if (k === undefined) {
      continue;
    }
    for (const right of rightsBy.get(k) ?? []) {
      if (accept(left, right)) {
        out.push([left, right]);
      }
    }
  }
  return out;
}

/** Cross-operator ordering that follows from what actions are, not from any workflow. */
const INFERENCE_RULES: InferenceRule[] = [
  {
    edges: (actions) =>
      pairs(
        ofKind(actions, "establish-target-exposure"),
        index(
          ofKind(actions, "redirect-concept-dependency"),
          (a) => a.target?.package
        ),
        packageOf,
        (e, r) =>
          r.subject.kind === "dependency" &&
          compatible(exposureId(e), r.subject.conceptId)
      ),
    id: "exposure-before-redirect",
    kind: "requires",
    reason: "the consumer can only depend on an exposed contract",
  },
  {
    edges: (actions) =>
      pairs(
        ofKind(actions, "redirect-concept-dependency"),
        index(ofKind(actions, "internalize-old-exposure"), packageOf),
        (r) =>
          r.subject.kind === "dependency" ? r.subject.provider : undefined,
        (r, i) =>
          r.subject.kind === "dependency" &&
          compatible(r.subject.conceptId, exposureId(i))
      ),
    id: "redirect-before-internalize",
    kind: "preserve-before-remove",
    reason: "the old exposure closes only after its consumers have moved",
  },
  {
    edges: (actions) =>
      pairs(
        ofKind(actions, "relocate-semantic-declaration"),
        index(ofKind(actions, "establish-target-exposure"), packageOf),
        (l) => l.target?.package,
        (l, e) =>
          l.subject.kind === "concept" &&
          compatible(l.subject.conceptId, exposureId(e))
      ),
    id: "relocate-before-exposure",
    kind: "requires",
    reason: "the target exposes what it now declares",
  },
  {
    edges: (actions) =>
      pairs(
        ofKind(actions, "relocate-behavior-responsibility"),
        index(ofKind(actions, "remove-boundary-participation"), (a) =>
          a.subject.kind === "boundary"
            ? a.subject.boundaryId.split("→")[0]
            : undefined
        ),
        (b) => b.current?.package,
        (b, x) =>
          b.subject.kind === "behavior" &&
          x.subject.kind === "boundary" &&
          compatible(b.subject.conceptId, x.subject.conceptId)
      ),
    id: "relocate-before-removal",
    kind: "requires",
    reason: "participation ends only after the behavior has moved",
  },
  {
    edges: (actions) =>
      pairs(
        ofKind(actions, "establish-target-exposure"),
        index(ofKind(actions, "preserve-public-exposure"), exposureId),
        exposureId,
        (e, p) => packageOf(e) !== packageOf(p)
      ),
    id: "exposure-before-forwarding",
    kind: "requires",
    reason:
      "the old exposure can only forward to a target that exposes the concept",
  },
  {
    edges: (actions) => {
      const placement = actions.filter(isPlacement);
      const byPackage = new Map<string, ComposedStructuralAction[]>();
      for (const action of placement) {
        for (const p of [action.current?.package, action.target?.package]) {
          if (p === undefined) {
            continue;
          }
          const list = byPackage.get(p);
          if (list === undefined) {
            byPackage.set(p, [action]);
          } else if (!list.includes(action)) {
            list.push(action);
          }
        }
      }
      return pairs(
        ofKind(actions, "preserve-anchor-boundary"),
        byPackage,
        packageOf,
        () => true
      );
    },
    id: "anchor-before-placement",
    kind: "preserve-before-remove",
    reason: "anchor holds",
  },
];

function inferDependencies(
  actions: ComposedStructuralAction[],
  explicit: ComposedActionDependency[]
): ComposedActionDependency[] {
  const known = new Set(explicit.map((d) => `${d.before} ${d.after}`));
  const inferred: ComposedActionDependency[] = [];
  for (const rule of INFERENCE_RULES) {
    for (const [before, after] of rule.edges(actions)) {
      if (before.id === after.id) {
        continue;
      }
      const key = `${before.id} ${after.id}`;
      if (known.has(key)) {
        continue;
      }
      known.add(key);
      inferred.push({
        after: after.id,
        before: before.id,
        kind: rule.kind,
        origin: "inferred",
        reason: rule.reason,
        rule: rule.id,
        sourceOperators: uniq([
          ...before.sourceOperators,
          ...after.sourceOperators,
        ]),
      });
    }
  }
  return inferred;
}

// ---------------------------------------------------------------------------
// Conflicts

class Conflicts {
  readonly list: OperatorCompositionConflict[] = [];

  add(
    kind: OperatorCompositionConflictKind,
    operators: string[],
    actions: string[],
    entities: string[],
    detail: string
  ): void {
    const conflict: OperatorCompositionConflict = {
      actions: uniq(actions),
      detail,
      entities: uniq(entities),
      kind,
      operators: uniq(operators),
    };
    const key = JSON.stringify([
      conflict.kind,
      conflict.operators,
      conflict.actions,
      conflict.entities,
    ]);
    if (
      this.list.some(
        (c) =>
          JSON.stringify([c.kind, c.operators, c.actions, c.entities]) === key
      )
    ) {
      return;
    }
    this.list.push(conflict);
  }
}

function operatorConflicts(inputs: Input[], acc: Conflicts): void {
  const relocating = (kind: ArchitecturalOperator["kind"]): boolean =>
    kind === "rehome-concept" || kind === "move";
  for (let i = 0; i < inputs.length; i += 1) {
    for (let j = i + 1; j < inputs.length; j += 1) {
      const a = inputs[i]?.operator;
      const b = inputs[j]?.operator;
      if (a === undefined || b === undefined) {
        continue;
      }
      const concept = conceptOf(a);
      if (concept === undefined || concept !== conceptOf(b)) {
        continue;
      }
      const ta = a.placement.target?.package;
      const tb = b.placement.target?.package;
      const sameFamily =
        (relocating(a.kind) && relocating(b.kind)) ||
        (a.kind === "rehome-behavior" && b.kind === "rehome-behavior");
      if (sameFamily && ta !== undefined && tb !== undefined && ta !== tb) {
        acc.add(
          "target-conflict",
          [a.id, b.id],
          [],
          [concept, ta, tb],
          `${concept}: ${a.kind} places it in ${ta}, ${b.kind} in ${tb}; both cannot be its final home`
        );
      }
      for (const [center, behavior] of [
        [a, b],
        [b, a],
      ]) {
        if (
          center?.kind !== "rehome-concept" ||
          behavior?.kind !== "rehome-behavior"
        ) {
          continue;
        }
        const target = center.placement.target?.package;
        if (
          target !== undefined &&
          currentPackages(behavior).includes(target)
        ) {
          acc.add(
            "operator-intent-conflict",
            [center.id, behavior.id],
            [],
            [concept, target],
            `${concept}: the semantic center moves into ${target} while governing behavior consolidates out of ${target}`
          );
        }
      }
    }
  }
}

/** Contradictions visible in the merged actions alone. */
export function detectActionConflicts(
  actions: ComposedStructuralAction[]
): OperatorCompositionConflict[] {
  const acc = new Conflicts();
  const divergent = (
    kind: OperatorCompositionConflictKind,
    group: ComposedStructuralAction[],
    what: string
  ): void => {
    const targets = uniq(group.map((a) => a.target?.package ?? "?"));
    if (targets.length < 2) {
      return;
    }
    acc.add(
      kind,
      group.flatMap((a) => a.sourceOperators),
      group.map((a) => a.id),
      [subjectKey(group[0]?.subject ?? { kind: "package", packageId: "?" })],
      `${what} is placed in ${targets.join(" and ")}; one final placement is required`
    );
  };
  for (const group of index(actions.filter(isPlacement), (a) =>
    canonicalActionId({ ...canonicalActionKey(a), target: undefined })
  ).values()) {
    divergent(
      "placement-conflict",
      group,
      `${group[0]?.kind ?? ""} of ${subjectKey(group[0]?.subject ?? { kind: "package", packageId: "?" })}`
    );
  }
  for (const group of index(
    ofKind(actions, "redirect-concept-dependency"),
    (a) => subjectKey(a.subject)
  ).values()) {
    divergent(
      "dependency-conflict",
      group,
      `the dependency ${subjectKey(group[0]?.subject ?? { kind: "package", packageId: "?" })}`
    );
  }
  const preserved = index(
    ofKind(actions, "preserve-public-exposure"),
    (a) => `${packageOf(a) ?? ""}#${exposureId(a) ?? ""}`
  );
  for (const internalize of ofKind(actions, "internalize-old-exposure")) {
    const id = exposureId(internalize);
    if (id === undefined) {
      continue;
    }
    for (const keep of preserved.get(`${packageOf(internalize) ?? ""}#${id}`) ??
      []) {
      acc.add(
        "exposure-conflict",
        [...internalize.sourceOperators, ...keep.sourceOperators],
        [internalize.id, keep.id],
        [id],
        `${packageOf(internalize) ?? "?"} both keeps and closes its exposure of ${id}`
      );
    }
  }
  for (const action of actions) {
    if (action.sourceOperators.length < 2) {
      continue;
    }
    for (const group of index(
      action.expectedEffects,
      (e) => `${e.dimension}:${e.change}`
    ).values()) {
      const states = group.map(stateOf);
      if (
        !states.some((a, i) =>
          states.some((b, j) => i < j && sameEndpoint(a, b))
        )
      ) {
        continue;
      }
      acc.add(
        "action-effect-conflict",
        action.sourceOperators,
        [action.id],
        [subjectKey(action.subject)],
        `${action.kind} on ${subjectKey(action.subject)} is expected to yield ${uniq(states.map((s) => `${s.from}→${s.to}`)).join(" and ")}; the operators describe different states`
      );
    }
  }
  return acc.list;
}

interface EffectState {
  from: string;
  to: string;
}

function stateOf(effect: OperatorExpectedEffect): EffectState {
  return {
    from: JSON.stringify(effect.from ?? null),
    to: JSON.stringify(effect.to ?? null),
  };
}

/** Two transitions describe the same step with a different other end: not two steps, one contradiction. */
function sameEndpoint(a: EffectState, b: EffectState): boolean {
  return (
    (a.from === b.from && a.to !== b.to) || (a.to === b.to && a.from !== b.from)
  );
}

interface Contradiction {
  cross: boolean;
  preservationId: string;
}

/** Operator preservations against actions of other operators; concept-scoped where the preservation is. */
function preservationConflicts(
  inputs: Input[],
  actions: ComposedStructuralAction[],
  acc: Conflicts
): Contradiction[] {
  const out: Contradiction[] = [];
  const relocations = ofKind(actions, "relocate-semantic-declaration");
  const internalizations = ofKind(actions, "internalize-old-exposure");
  const forwarding = ofKind(actions, "preserve-public-exposure");
  const placement = actions.filter(isPlacement);
  const conceptOfAction = (a: ComposedStructuralAction): string | undefined =>
    a.subject.kind === "concept" ? a.subject.conceptId : undefined;
  /** The old exposure stays through an explicit forwarding action. */
  const forwarded = (relocation: ComposedStructuralAction): boolean =>
    forwarding.some(
      (f) =>
        packageOf(f) === relocation.current?.package &&
        exposureId(f) === conceptOfAction(relocation)
    );
  for (const { operator } of inputs) {
    const concept = conceptOf(operator);
    const home = homeOf(operator);
    for (const preservation of operator.preservations) {
      const id = preservationId(preservation);
      let hits: ComposedStructuralAction[] = [];
      let kind: OperatorCompositionConflictKind = "preservation-conflict";
      let detail = "";
      switch (preservation.kind) {
        case "semantic-center":
          hits = relocations.filter(
            (a) =>
              conceptOfAction(a) === concept &&
              preservation.entityIds.includes(a.current?.package ?? "")
          );
          detail = `the semantic center of ${concept ?? "?"} is preserved in ${preservation.entityIds.join(", ")} and relocated out of it`;
          break;
        case "public-contract":
          hits = [
            ...relocations.filter(
              (a) =>
                (concept === undefined || conceptOfAction(a) === concept) &&
                preservation.entityIds.includes(a.current?.package ?? "") &&
                !forwarded(a)
            ),
            ...internalizations.filter(
              (a) =>
                preservation.entityIds.includes(packageOf(a) ?? "") &&
                (concept === undefined || exposureId(a) === concept)
            ),
          ];
          detail = `the public contract of ${preservation.entityIds.join(", ")} is preserved and changed`;
          break;
        case "consumer-import-path":
          kind = "exposure-conflict";
          hits = [
            ...internalizations.filter(
              (a) => packageOf(a) === home && exposureId(a) === concept
            ),
            ...relocations.filter(
              (a) =>
                conceptOfAction(a) === concept &&
                a.current?.package === home &&
                !forwarded(a)
            ),
          ];
          detail = `${preservation.entityIds.join(", ")} keep importing ${concept ?? "?"} from ${home ?? "?"}, which stops exposing it`;
          break;
        case "anchor":
          kind = "anchor-conflict";
          hits = placement.filter((a) =>
            preservation.entityIds.includes(a.current?.package ?? "")
          );
          detail = `${preservation.entityIds.join(", ")} keeps its anchored boundary while responsibility leaves it`;
          break;
        case "representation-boundary":
        case "implementation-split":
        case "runtime-behavior":
          break;
      }
      for (const hit of hits) {
        const cross = hit.sourceOperators.some((o) => o !== operator.id);
        out.push({ cross, preservationId: id });
        if (cross) {
          acc.add(
            kind,
            [operator.id, ...hit.sourceOperators],
            [hit.id],
            [id],
            detail
          );
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preservations, effects, verification

function composePreservations(
  inputs: Input[],
  actions: ComposedStructuralAction[],
  contradictions: Contradiction[]
): CompositionPreservation[] {
  const groups = new Map<string, CompositionPreservation>();
  for (const { operator } of inputs) {
    for (const preservation of operator.preservations) {
      const id = preservationId(preservation);
      const entry = groups.get(id);
      if (entry === undefined) {
        groups.set(id, {
          coverageActions: [],
          entityIds: preservation.entityIds,
          kind: preservation.kind,
          preservationId: id,
          requiredByOperators: [operator.id],
          status: "implicit",
        });
      } else {
        entry.requiredByOperators.push(operator.id);
      }
    }
  }
  return [...groups.values()]
    .sort((a, b) => byId(a.preservationId, b.preservationId))
    .map((entry) => {
      const coverageActions = actions
        .filter((a) => a.preserves.includes(entry.preservationId))
        .map((a) => a.id);
      const hits = contradictions.filter(
        (c) => c.preservationId === entry.preservationId
      );
      const status: CompositionPreservation["status"] = hits.some(
        (c) => c.cross
      )
        ? "conflicted"
        : coverageActions.length > 0
          ? "covered"
          : hits.length > 0
            ? "uncovered"
            : "implicit";
      return {
        ...entry,
        coverageActions: sorted(coverageActions),
        requiredByOperators: uniq(entry.requiredByOperators),
        status,
      };
    });
}

/**
 * Effects on one dimension, change, and subject relate; nothing is summed.
 * Identical effects from two operators are `duplicate`; two operators
 * describing the same step with different other ends are `conflicting`;
 * anything else (different edges, sequential steps) is `compatible`.
 */
function composeEffects(
  inputs: Input[],
  actions: ComposedStructuralAction[],
  acc: Conflicts
): CompositionEffect[] {
  const groups = new Map<
    string,
    {
      effect: CompositionEffect;
      operators: Set<string>;
      owners: { operator: string; state: EffectState }[];
    }
  >();
  for (const { operator } of inputs) {
    const subject = subjectIdOf(operator);
    for (const effect of operator.expectedEffects) {
      const key = `${effect.dimension} ${effect.change} ${subject}`;
      let entry = groups.get(key);
      if (entry === undefined) {
        entry = {
          effect: {
            change: effect.change,
            changes: [],
            dimension: effect.dimension,
            relation: "compatible",
            sourceOperators: [],
            subjects: [subject],
          },
          operators: new Set(),
          owners: [],
        };
        groups.set(key, entry);
      }
      entry.operators.add(operator.id);
      entry.owners.push({ operator: operator.id, state: stateOf(effect) });
      if (!entry.effect.changes.some((e) => sameEffect(e, effect))) {
        entry.effect.changes.push(effect);
      }
    }
  }
  return [...groups.keys()].sort(byId).map((key) => {
    const entry = groups.get(key);
    if (entry === undefined) {
      throw new Error("unreachable");
    }
    const { effect, owners } = entry;
    const states = effect.changes.map(stateOf);
    let relation: CompositionEffect["relation"] = "compatible";
    if (states.length === 1 && entry.operators.size > 1) {
      relation = "duplicate";
    }
    if (
      owners.some((a) =>
        owners.some(
          (b) => a.operator !== b.operator && sameEndpoint(a.state, b.state)
        )
      )
    ) {
      relation = "conflicting";
    }
    if (relation === "conflicting") {
      acc.add(
        "action-effect-conflict",
        [...entry.operators],
        actions
          .filter((a) =>
            a.expectedEffects.some((e) =>
              effect.changes.some((c) => sameEffect(c, e))
            )
          )
          .map((a) => a.id),
        effect.subjects,
        `${effect.dimension} ${effect.change} of ${effect.subjects.join(", ")} is expected to end as ${uniq(states.map((s) => s.to)).join(" and ")}`
      );
    }
    return {
      ...effect,
      relation,
      sourceOperators: sorted([...entry.operators]),
    };
  });
}

const SUBJECT_VERIFICATIONS = new Set<string>([
  "concept-center",
  "behavior-location",
  "public-surface",
]);

function composeVerification(
  inputs: Input[],
  actions: ComposedStructuralAction[]
): CompositionVerification[] {
  const groups = new Map<
    string,
    { entry: CompositionVerification; related: Set<string> }
  >();
  for (const { operator } of inputs) {
    const own = actions.filter((a) => a.sourceOperators.includes(operator.id));
    const coverage = coverVerification(operator, own);
    for (const requirement of operator.verification) {
      const key = `${requirement.kind} ${JSON.stringify(requirement.expected)}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          entry: {
            expected: requirement.expected,
            kind: requirement.kind,
            relatedActions: [],
            requiredByOperators: [],
            status: "compatible",
          },
          related: new Set(),
        };
        groups.set(key, group);
      }
      group.entry.requiredByOperators.push(operator.id);
      for (const id of coverage.find(
        (c) => c.requirementId === requirement.kind
      )?.relatedActions ?? []) {
        group.related.add(id);
      }
    }
  }
  const entries = [...groups.keys()].sort(byId).map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      throw new Error("unreachable");
    }
    return {
      ...group.entry,
      relatedActions: sorted([...group.related]),
      requiredByOperators: uniq(group.entry.requiredByOperators),
    };
  });
  const subjectOf = (v: CompositionVerification): string | undefined =>
    SUBJECT_VERIFICATIONS.has(v.kind) && Array.isArray(v.expected)
      ? `${v.kind}:${v.expected[0] ?? ""}`
      : undefined;
  const bySubject = index(entries, subjectOf);
  return entries.map((entry) => {
    const subject = subjectOf(entry);
    const conflicting =
      subject !== undefined && (bySubject.get(subject)?.length ?? 0) > 1;
    return {
      ...entry,
      status: conflicting
        ? "conflicting"
        : entry.relatedActions.length === 0
          ? "unresolved"
          : "compatible",
    };
  });
}

// ---------------------------------------------------------------------------
// Gaps

/**
 * Only a surface transition can be settled by another operator: an action
 * of another operator that keeps or closes the old exposure of the same
 * concept says what the rehome left open. Module choice, boundary scope,
 * conformance, coverage, and representation gaps are facts no intent
 * resolves.
 */
function composeGaps(
  inputs: Input[],
  actions: ComposedStructuralAction[]
): {
  unresolved: OperatorCompositionGap[];
  resolutions: CompositionGapResolution[];
} {
  const unresolved: OperatorCompositionGap[] = [];
  const resolutions: CompositionGapResolution[] = [];
  for (const { operator, decomposition } of inputs) {
    const concept = conceptOf(operator);
    for (const gap of decomposition.unresolved) {
      const id = `${operator.id}/${gap.kind}:${gap.entities.join(",")}`;
      let candidates: ComposedStructuralAction[] = [];
      if (gap.kind === "surface-transition-unspecified") {
        const [current] = gap.entities;
        candidates = actions.filter(
          (a) =>
            (a.kind === "preserve-public-exposure" ||
              a.kind === "internalize-old-exposure") &&
            packageOf(a) === current &&
            exposureId(a) === concept &&
            a.sourceOperators.some((o) => o !== operator.id)
        );
      }
      const kinds = uniq(candidates.map((a) => a.kind));
      const status: CompositionGapResolution["status"] =
        candidates.length === 0
          ? "unresolved"
          : kinds.length > 1
            ? "conflicted"
            : "resolved";
      resolutions.push({
        gapId: id,
        resolvedByActions: uniq(candidates.map((a) => a.id)),
        resolvedByOperators: uniq(
          candidates
            .flatMap((a) => a.sourceOperators)
            .filter((o) => o !== operator.id)
        ),
        sourceOperator: operator.id,
        status,
      });
      if (status !== "resolved") {
        unresolved.push({ ...gap, id, sourceOperator: operator.id });
      }
    }
  }
  return {
    resolutions: resolutions.sort((a, b) => byId(a.gapId, b.gapId)),
    unresolved: unresolved.sort((a, b) => byId(a.id, b.id)),
  };
}

// ---------------------------------------------------------------------------
// Identity

function compositionId(operators: ArchitecturalOperator[]): string {
  const facts = [
    ...operators.map((o) => `${o.id}=${o.fingerprint.hash}`).sort(byId),
    `schema:${COMPOSITION_SCHEMA_VERSION}`,
  ];
  return `composition:${hash16(facts)}`;
}

function compositionFingerprint(inputs: Input[]): {
  facts: string[];
  hash: string;
} {
  const facts = [
    ...inputs.map(
      (i) => `operator:${i.operator.id}=${i.operator.fingerprint.hash}`
    ),
    ...inputs.map(
      (i) =>
        `decomposition:${i.operator.id}=${i.decomposition.fingerprint.hash}`
    ),
    `composition-rules:${COMPOSITION_RULES_VERSION}`,
    `composition-schema:${COMPOSITION_SCHEMA_VERSION}`,
  ].sort(byId);
  return { facts, hash: hash16(facts) };
}

// ---------------------------------------------------------------------------
// Entry points

/** Actions on a dependency loop: peel sources and sinks until only loops remain. */
export function cycleMembers(
  actions: StructuralAction[],
  dependencies: StructuralActionDependency[]
): string[] {
  const members = new Set(actions.map((a) => a.id));
  const edges = dependencies.filter(
    (d) => members.has(d.before) && members.has(d.after)
  );
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const id of [...members]) {
      const hasIn = edges.some((d) => d.after === id && members.has(d.before));
      const hasOut = edges.some((d) => d.before === id && members.has(d.after));
      if (hasIn && hasOut) {
        continue;
      }
      members.delete(id);
      pruned = true;
    }
  }
  return sorted([...members]);
}

function sortConflicts(
  conflicts: OperatorCompositionConflict[]
): OperatorCompositionConflict[] {
  return [...conflicts].sort(
    (a, b) =>
      byId(a.kind, b.kind) ||
      byId(a.entities.join(","), b.entities.join(",")) ||
      byId(a.operators.join(","), b.operators.join(",")) ||
      byId(a.actions.join(","), b.actions.join(","))
  );
}

function sortDependencies(
  dependencies: ComposedActionDependency[]
): ComposedActionDependency[] {
  return [...dependencies].sort(
    (a, b) =>
      byId(a.before, b.before) ||
      byId(a.after, b.after) ||
      byId(a.origin, b.origin)
  );
}

/**
 * Compose the supplied operators into one structural action graph. Nothing
 * is selected: every operator given takes part. Equivalent actions merge
 * with provenance, dependencies merge and cross-operator ones are inferred
 * from fixed rules, and every contradiction is listed rather than decided.
 */
export function composeArchitecturalOperators(
  operators: ArchitecturalOperator[],
  decompositions: OperatorDecomposition[],
  context: OperatorContext
): OperatorComposition {
  const taken = intake(operators, decompositions, context);
  const { inputs } = taken;
  const { actions: merged, shared, idMap, inputActions } = mergeActions(inputs);
  const explicit = mergeDependencies(inputs, idMap);
  const inferred = inferDependencies(merged, explicit);
  const dependencies = sortDependencies([...explicit, ...inferred]);

  const conflicts = new Conflicts();
  const { layer } = layers(merged, dependencies);
  const cycle = cycleMembers(merged, dependencies);
  if (cycle.length > 0) {
    conflicts.add(
      "action-order-conflict",
      merged
        .filter((a) => cycle.includes(a.id))
        .flatMap((a) => a.sourceOperators),
      cycle,
      [],
      `the merged dependencies form a cycle through ${cycle.join(", ")}; the operators order the same work differently`
    );
  }
  operatorConflicts(inputs, conflicts);
  for (const conflict of detectActionConflicts(merged)) {
    conflicts.add(
      conflict.kind,
      conflict.operators,
      conflict.actions,
      conflict.entities,
      conflict.detail
    );
  }
  const contradictions = preservationConflicts(inputs, merged, conflicts);
  const preservations = composePreservations(inputs, merged, contradictions);
  const effects = composeEffects(inputs, merged, conflicts);
  const verification = composeVerification(inputs, merged);
  const { unresolved, resolutions } = composeGaps(inputs, merged);

  const actions = orderActions(merged, layer);
  const conflicted =
    conflicts.list.length > 0 ||
    verification.some((v) => v.status === "conflicting") ||
    resolutions.some((r) => r.status === "conflicted");
  const status: OperatorCompositionStatus =
    taken.stale.length > 0
      ? "stale"
      : taken.unsupported.length > 0
        ? "unsupported"
        : conflicted
          ? "conflicted"
          : taken.blocked.length > 0
            ? "blocked"
            : unresolved.length > 0
              ? "partial"
              : "complete";
  return {
    actions,
    conflicts: sortConflicts(conflicts.list),
    dependencies,
    diagnostics: {
      conflicts: conflicts.list.length,
      explicitDependencies: explicit.length,
      gapsRemaining: unresolved.length,
      gapsResolved: resolutions.filter((r) => r.status === "resolved").length,
      inferredDependencies: inferred.length,
      inputActions,
      inputOperators: inputs.length,
      mergedActions: actions.length,
      redecomposed: taken.redecomposed,
      sharedActions: shared.length,
    },
    effects,
    fingerprint: compositionFingerprint(inputs),
    groups: groupActions(actions),
    id: compositionId(inputs.map((i) => i.operator)),
    inputProblems: taken.problems,
    operators: inputs.map((i) => i.operator.id),
    preservations,
    resolutions,
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    sharedActions: shared,
    status,
    unresolved,
    verification,
  };
}

/**
 * Check a composition record against its inputs and the current facts. The
 * composition is rebuilt from the same inputs and compared part by part:
 * a moved operator, decomposition, or fact is `stale`; a record that no
 * longer matches what its inputs compose to is `invalid`.
 */
export function validateOperatorComposition(
  composition: OperatorComposition,
  operators: ArchitecturalOperator[],
  decompositions: OperatorDecomposition[],
  context: OperatorContext
): OperatorCompositionValidation {
  const problems: string[] = [];
  const fresh = composeArchitecturalOperators(
    operators,
    decompositions,
    context
  );
  const base = {
    compositionId: composition.id,
    currentFingerprint: fresh.fingerprint.hash,
    fingerprint: composition.fingerprint.hash,
  };
  const actionIds = new Set(composition.actions.map((a) => a.id));
  for (const d of composition.dependencies) {
    if (!(actionIds.has(d.before) && actionIds.has(d.after))) {
      problems.push(
        `dependency ${d.before} → ${d.after} names an unknown action`
      );
    }
  }
  const cycle = cycleMembers(composition.actions, composition.dependencies);
  const cycles = cycle.length === 0 ? [] : [cycle];
  if (
    cycle.length > 0 &&
    !composition.conflicts.some((c) => c.kind === "action-order-conflict")
  ) {
    problems.push(`actions form an unreported cycle: ${cycle.join(", ")}`);
  }

  if (
    fresh.status === "stale" ||
    fresh.fingerprint.hash !== composition.fingerprint.hash
  ) {
    problems.push(
      fresh.status === "stale"
        ? `an operator no longer matches the facts: ${fresh.inputProblems.join("; ")}`
        : "an operator or decomposition moved since the composition was built"
    );
    return { ...base, cycles, problems, status: "stale" };
  }

  const expectedOperators = uniq(operators.map((o) => o.id));
  if (composition.operators.join(",") !== expectedOperators.join(",")) {
    problems.push(
      `composition covers ${composition.operators.join(", ")}, inputs are ${expectedOperators.join(", ")}`
    );
  }
  const sourceIds = new Set(fresh.actions.flatMap((a) => a.sourceActions));
  for (const action of composition.actions) {
    for (const source of action.sourceActions) {
      if (!sourceIds.has(source)) {
        problems.push(
          `${action.id}: source action ${source} is not in any decomposition`
        );
      }
    }
  }
  for (const shared of composition.sharedActions) {
    if (shared.sourceActions.length < 2) {
      problems.push(`${shared.mergedActionId}: shared action has one source`);
    }
    if (!actionIds.has(shared.mergedActionId)) {
      problems.push(`${shared.mergedActionId}: shared action is not an action`);
    }
  }
  const gapIds = new Set(composition.resolutions.map((r) => r.gapId));
  for (const { operator, decomposition } of fresh.operators.map((id) => ({
    decomposition: decompositions.find((d) => d.operatorId === id),
    operator: id,
  }))) {
    for (const gap of decomposition?.unresolved ?? []) {
      if (!gapIds.has(`${operator}/${gap.kind}:${gap.entities.join(",")}`)) {
        problems.push(`gap ${gap.kind} of ${operator} has no resolution entry`);
      }
    }
  }

  const parts: (keyof OperatorComposition)[] = [
    "actions",
    "dependencies",
    "sharedActions",
    "conflicts",
    "preservations",
    "effects",
    "verification",
    "unresolved",
    "resolutions",
    "status",
  ];
  for (const part of parts) {
    if (JSON.stringify(composition[part]) !== JSON.stringify(fresh[part])) {
      problems.push(`${part} differ from what the inputs compose to`);
    }
  }

  return {
    ...base,
    cycles,
    problems,
    status: problems.length === 0 ? "valid" : "invalid",
  };
}
