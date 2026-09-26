import type {
  OperatorDecomposition,
  OperatorDecompositionValidation,
  StructuralAction,
  StructuralActionDefinition,
} from "./operator-decomposition-types";
import type { ArchitecturalOperator, OperatorFact } from "./operator-types";

// Text view over a decomposition. Reads the record only; derives nothing.

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

function subjectLine(action: StructuralAction): string {
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
  }
}

function placementLine(action: StructuralAction): string[] {
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

export function renderOperatorDecomposition(
  operator: ArchitecturalOperator,
  decomposition: OperatorDecomposition,
  validation?: OperatorDecompositionValidation
): string {
  const index = new Map(decomposition.actions.map((a, i) => [a.id, i + 1]));
  const lines = [
    ...heading("OPERATOR DECOMPOSITION"),
    "",
    operator.kind,
    `operator ${operator.id}`,
    ...(operator.placement.current?.package === undefined
      ? []
      : [
          `${operator.placement.current.package}${operator.placement.target?.package === undefined ? "" : ` → ${operator.placement.target.package}`}`,
        ]),
  ];
  for (const group of decomposition.groups) {
    const body: string[] = [];
    for (const id of group.actionIds) {
      const action = decomposition.actions.find((a) => a.id === id);
      if (action === undefined) {
        continue;
      }
      const n = index.get(id) ?? 0;
      const dependsOn = decomposition.dependencies
        .filter((d) => d.after === id)
        .map((d) => `[${index.get(d.before) ?? "?"}]`);
      body.push(
        `[${n}] ${action.kind} (${action.status})`,
        `    ${subjectLine(action)}`,
        ...placementLine(action).map((l) => `    ${l}`),
        `    ${action.intent.summary}`,
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
      "Preserve",
      decomposition.preservationCoverage.map(
        (c) =>
          `${c.preservationId} (${c.status}${c.coveredByActions.length === 0 ? "" : `: ${c.coveredByActions.map((id) => `[${index.get(id) ?? "?"}]`).join(" ")}`})`
      )
    ),
    ...section(
      "Expected",
      decomposition.effectCoverage.map(
        (c) =>
          `${c.operatorEffectId} (${c.status}${c.actions.length === 0 ? "" : `: ${c.actions.map((id) => `[${index.get(id) ?? "?"}]`).join(" ")}`})`
      )
    ),
    ...section(
      "Verify",
      decomposition.verificationCoverage.map(
        (c) =>
          `${c.requirementId} (${c.status}${c.relatedActions.length === 0 ? "" : `: ${c.relatedActions.map((id) => `[${index.get(id) ?? "?"}]`).join(" ")}`})`
      )
    ),
    ...section(
      "Unresolved",
      decomposition.unresolved.map(
        (g) =>
          `${g.kind}${g.blocking ? " [blocking]" : ""} ${g.entities.join(", ")}${g.entities.length === 0 ? "" : ": "}${g.detail}`
      )
    ),
    "",
    "Status",
    `  ${decomposition.status}`,
    `  fingerprint ${decomposition.fingerprint.hash}`
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

export function renderStructuralActionDefinitions(
  definitions: StructuralActionDefinition[]
): string {
  const lines = [...heading("STRUCTURAL ACTIONS")];
  for (const definition of definitions) {
    lines.push(
      "",
      definition.kind,
      `  group ${definition.group}`,
      `  subjects ${definition.supportedSubjects.join(", ")}`,
      `  target ${definition.requiresTarget ? "required" : "optional"}`
    );
  }
  return lines.join("\n");
}
