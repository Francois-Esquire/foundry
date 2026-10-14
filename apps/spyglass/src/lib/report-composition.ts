import type {
  ComposedStructuralAction,
  OperatorComposition,
  OperatorCompositionValidation,
} from "./operator-composition-types";
import type { OperatorFact } from "./operator-types";

// Text view over a composition. Reads the record only; derives nothing.

function fact(value: OperatorFact | undefined): string {
  if (value === undefined || value === null) {
    return "?";
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "(none)" : value.join(", ");
  }
  return String(value);
}

function heading(title: string): string[] {
  return [title, "═".repeat(title.length)];
}

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  return ["", title, ...lines.map((line) => `  ${line}`)];
}

function subjectLine(action: ComposedStructuralAction): string {
  const { subject } = action;
  switch (subject.kind) {
    case "concept":
      return subject.conceptId;
    case "symbol":
      return subject.symbolId;
    case "behavior":
      return `${subject.role} behavior of ${subject.conceptId}`;
    case "boundary":
      return subject.conceptId === undefined
        ? subject.boundaryId
        : `${subject.conceptId} across ${subject.boundaryId}`;
    case "exposure":
      return `${subject.package} exposes ${subject.conceptId ?? subject.symbolId ?? "(unspecified)"}`;
    case "dependency":
      return `${subject.consumer} → ${subject.provider}${subject.conceptId === undefined ? "" : ` for ${subject.conceptId}`}`;
    case "package":
      return subject.packageId;
    default:
      throw new Error("Unexpected subject.kind.");
  }
}

function placementLine(action: ComposedStructuralAction): string[] {
  const current = action.current?.package;
  const target = action.target?.package;
  if (current === undefined && target === undefined) {
    return [];
  }
  if (target === undefined) {
    return [`at ${current ?? "?"}`];
  }
  if (current === undefined) {
    return [`into ${target}`];
  }
  return [`${current} → ${target}`];
}

export function renderOperatorComposition(
  composition: OperatorComposition,
  validation?: OperatorCompositionValidation
): string {
  const index = new Map(composition.actions.map((a, i) => [a.id, i + 1]));
  const ref = (id: string): string => `[${index.get(id) ?? "?"}]`;
  const d = composition.diagnostics;
  const lines = [
    ...heading("OPERATOR COMPOSITION"),
    ...section("Operators", [
      String(d.inputOperators),
      ...composition.operators,
    ]),
    ...section("Actions", [
      `${d.inputActions} input`,
      `${d.mergedActions} composed`,
      `${d.sharedActions} shared`,
    ]),
    ...section("Dependencies", [
      `${d.explicitDependencies} explicit`,
      `${d.inferredDependencies} inferred`,
    ]),
  ];
  for (const group of composition.groups) {
    const body: string[] = [];
    for (const id of group.actionIds) {
      const action = composition.actions.find((a) => a.id === id);
      if (action === undefined) {
        continue;
      }
      const dependsOn = composition.dependencies
        .filter((dep) => dep.after === id)
        .map((dep) =>
          dep.origin === "inferred"
            ? `${ref(dep.before)} (inferred: ${dep.rule ?? ""})`
            : ref(dep.before)
        );
      body.push(
        `${ref(id)} ${action.kind} (${action.status})`,
        `    ${subjectLine(action)}`,
        ...placementLine(action).map((l) => `    ${l}`),
        `    ${action.intent.summary}`,
        `    from ${action.sourceOperators.join(", ")}`,
        ...(dependsOn.length === 0
          ? []
          : [`    depends on ${dependsOn.join(" ")}`]),
        ...action.expectedEffects.map((e) =>
          e.to === undefined
            ? `    expects ${e.change} ${fact(e.from)} (${e.certainty})`
            : `    expects ${e.change} ${fact(e.from)} → ${fact(e.to)} (${e.certainty})`
        )
      );
    }
    lines.push(...section(group.kind, body));
  }
  lines.push(
    ...section(
      "Shared",
      composition.sharedActions.map(
        (s) => `${ref(s.mergedActionId)} ← ${s.sourceActions.join(", ")}`
      )
    ),
    "",
    "Conflicts",
    ...resolveRenderOperatorComposition(composition, ref),
    ...section(
      "Preserve",
      composition.preservations.map(
        (p) =>
          `${p.preservationId} (${p.status}${p.coverageActions.length === 0 ? "" : `: ${p.coverageActions.map(ref).join(" ")}`}) for ${p.requiredByOperators.join(", ")}`
      )
    ),
    ...section(
      "Expected",
      composition.effects.map(
        (e) =>
          `${e.dimension} ${e.change} of ${e.subjects.join(", ")} (${e.relation}): ${e.changes.map((c) => `${fact(c.from)} → ${fact(c.to)}`).join("; ")}`
      )
    ),
    ...section(
      "Verify",
      composition.verification.map(
        (v) =>
          `${v.kind} ${fact(v.expected)} (${v.status}${v.relatedActions.length === 0 ? "" : `: ${v.relatedActions.map(ref).join(" ")}`})`
      )
    ),
    ...section("Gaps", [
      ...composition.resolutions
        .filter((r) => r.status === "resolved")
        .map(
          (r) =>
            `resolved ${r.gapId} by ${r.resolvedByOperators.join(", ")} ${r.resolvedByActions.map(ref).join(" ")}`
        ),
      ...composition.unresolved.map(
        (g) =>
          `${g.kind}${g.blocking ? " [blocking]" : ""} ${g.entities.join(", ")}${g.entities.length === 0 ? "" : ": "}${g.detail} (${g.sourceOperator})`
      ),
    ]),
    ...section("Input", composition.inputProblems),
    "",
    "Status",
    `  ${composition.status}`,
    `  ${composition.id}`,
    `  fingerprint ${composition.fingerprint.hash}`
  );
  if (validation !== undefined) {
    lines.push(
      ...section("Validation", [
        validation.status,
        ...validation.problems,
        ...(validation.currentFingerprint === undefined
          ? []
          : [`current fingerprint ${validation.currentFingerprint}`]),
      ])
    );
  }
  return lines.join("\n");
}

function resolveRenderOperatorComposition(
  composition: OperatorComposition,
  ref: (id: string) => string
): string[] {
  if (composition.conflicts.length === 0) {
    return ["  none"];
  }
  return composition.conflicts.map(
    (c) =>
      `  ${c.kind}: ${c.detail}${c.actions.length === 0 ? "" : ` ${c.actions.map(ref).join(" ")}`} (${c.operators.join(", ")})`
  );
}
