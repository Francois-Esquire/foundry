import type {
  ArchitecturalOperator,
  OperatorDefinition,
  OperatorFact,
  OperatorFromScenarioResult,
  OperatorValidation,
} from "./operator-types";

// Text views over operators. They read the operator and its validation
// only; nothing here derives a fact.

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

function subjectLine(operator: ArchitecturalOperator): string[] {
  const { subject } = operator;
  switch (subject.kind) {
    case "symbol":
      return [`symbol ${subject.name} (${subject.package})`, subject.symbolId];
    case "concept":
      return [`concept ${subject.conceptId}`];
    case "behavior":
      return [
        `behavior of ${subject.conceptId}`,
        `in ${subject.packages.join(", ")}`,
      ];
    case "package":
      return [`package ${subject.packageId}`];
    case "boundary":
      return [`boundary ${subject.boundaryId}`];
  }
}

export function renderOperator(
  operator: ArchitecturalOperator,
  validation?: OperatorValidation
): string {
  const lines = [
    ...heading("OPERATOR"),
    "",
    operator.kind,
    `id ${operator.id}`,
    ...section("Subject", subjectLine(operator)),
    ...section("Intent", [
      operator.intent.reason,
      `source ${operator.intent.source}`,
      ...(operator.intent.scenarioId === undefined
        ? []
        : [`scenario ${operator.intent.scenarioId}`]),
      ...(operator.intent.reviewId === undefined
        ? []
        : [`review ${operator.intent.reviewId}`]),
      ...(operator.intent.planId === undefined
        ? []
        : [`plan ${operator.intent.planId}`]),
    ]),
    ...section("From", [
      ...(operator.placement.current?.package === undefined
        ? []
        : [operator.placement.current.package]),
    ]),
    ...section("To", [
      ...(operator.placement.target?.package === undefined
        ? []
        : [operator.placement.target.package]),
    ]),
    ...section(
      "Preconditions",
      operator.preconditions.map(
        (p) => `${p.kind} ${p.entityIds.join(",")} = ${fact(p.expected)}`
      )
    ),
    ...section(
      "Preserve",
      operator.preservations.map(
        (p) =>
          `${p.kind} ${fact(p.entityIds)}${p.reason === undefined ? "" : ` — ${p.reason}`}`
      )
    ),
    ...section(
      "Expected",
      operator.expectedEffects.map((e) =>
        e.to === undefined
          ? `${e.dimension} ${e.change} ${fact(e.from)} (${e.certainty})`
          : `${e.dimension} ${e.change} ${fact(e.from)} → ${fact(e.to)} (${e.certainty})`
      )
    ),
    ...section(
      "Verify",
      operator.verification.map((v) => `${v.kind} ${fact(v.expected)}`)
    ),
    ...section(
      "Constraints",
      operator.constraints.map((c) => `${c.kind} [${c.effect}] ${c.detail}`)
    ),
    ...section(
      "Evidence",
      operator.evidence.map((e) => `${e.source} ${e.entityIds.join(", ")}`)
    ),
    "",
    "Status",
    `  ${validation?.status ?? operator.status}`,
    `  fingerprint ${operator.fingerprint.hash}`,
  ];
  if (validation !== undefined) {
    lines.push(
      ...section("Validation", [
        ...validation.preconditions
          .filter((p) => !p.holds)
          .map(
            (p) =>
              `${p.kind} ${p.entityIds.join(",")}: expected ${fact(p.expected)}, found ${fact(p.actual)}`
          ),
        ...validation.cautions,
        ...(validation.currentFingerprint === undefined
          ? []
          : [`current fingerprint ${validation.currentFingerprint}`]),
      ])
    );
  }
  return lines.join("\n");
}

export function renderOperatorFromScenario(
  result: OperatorFromScenarioResult,
  validation?: OperatorValidation
): string {
  if (result.status === "created") {
    return renderOperator(result.operator, validation);
  }
  return [
    ...heading("OPERATOR"),
    "",
    "unsupported",
    `scenario ${result.scenarioId}`,
    ...(result.scenarioKind === undefined
      ? []
      : [`kind ${result.scenarioKind}`]),
    result.reason,
  ].join("\n");
}

export function renderOperatorDefinitions(
  definitions: OperatorDefinition[]
): string {
  const lines = [...heading("OPERATOR DEFINITIONS")];
  for (const definition of definitions) {
    lines.push(
      "",
      `${definition.kind}${definition.executable ? "  (executable via " + (definition.legacyOperatorId ?? "?") + ")" : ""}`,
      `  ${definition.summary}`,
      `  subjects ${definition.supportedSubjects.join(", ")}`,
      `  requires ${definition.requiredFields.join(", ")}`,
      `  verify ${definition.verificationKinds.join(", ")}`
    );
  }
  return lines.join("\n");
}
