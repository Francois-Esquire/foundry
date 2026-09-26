import type {
  OperatorExecutionPlan,
  OperatorExecutionPlanValidation,
  PlannedSourceState,
  PlannedTransformation,
} from "./operator-plan-types";
import type { OperatorFact } from "./operator-types";

// Text view over an execution plan. Reads the record only; derives nothing.

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

function state(value: PlannedSourceState | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (value.module !== undefined) {
    parts.push(value.module);
  } else if (value.package !== undefined) {
    parts.push(value.package);
  }
  if (value.specifier !== undefined) {
    parts.push(`"${value.specifier}"`);
  }
  if (value.exportForm !== undefined) {
    parts.push(value.exportForm);
  }
  if (value.importKind !== undefined) {
    parts.push(`${value.importKind} import`);
  }
  if (value.names !== undefined && value.names.length > 0) {
    parts.push(`{ ${value.names.join(", ")} }`);
  }
  if (value.dependency !== undefined) {
    parts.push(
      `${value.dependency.declared ? "depends on" : "no dependency on"} ${value.dependency.package}${value.runtime === true ? " (runtime)" : ""}`
    );
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

function transformationLines(
  t: PlannedTransformation,
  ref: (id: string) => string,
  dependsOn: string[]
): string[] {
  const subject =
    t.subject?.symbolId ?? t.subject?.moduleId ?? t.subject?.packageId;
  const before = state(t.before);
  const after = state(t.after);
  return [
    `${ref(t.id)} ${t.kind} (${t.status})`,
    `    ${t.file}`,
    ...(subject === undefined ? [] : [`    subject: ${subject}`]),
    ...(before === undefined && after === undefined
      ? []
      : [`    ${before ?? "(absent)"} → ${after ?? "(absent)"}`]),
    `    ${t.detail}`,
    ...(dependsOn.length === 0 ? [] : [`    after ${dependsOn.join(" ")}`]),
  ];
}

export function renderOperatorExecutionPlan(
  plan: OperatorExecutionPlan,
  validation?: OperatorExecutionPlanValidation
): string {
  const index = new Map(plan.transformations.map((t, i) => [t.id, i + 1]));
  const ref = (id: string): string => `[${index.get(id) ?? "?"}]`;
  const refs = (ids: string[]): string =>
    [...ids]
      .sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
      .map(ref)
      .join(" ");
  const d = plan.diagnostics;
  const lines = [
    ...heading("OPERATOR PLAN"),
    ...section("Composition", [plan.compositionId]),
    ...section("Status", [plan.status]),
    ...section("Files", [
      `${d.sourceFiles} source`,
      `${d.testFiles} tests`,
      `${d.manifests} package manifests`,
    ]),
    ...section(
      "Transformations",
      plan.transformations.flatMap((t) =>
        transformationLines(
          t,
          ref,
          plan.dependencies
            .filter((dep) => dep.after === t.id)
            .map((dep) => ref(dep.before))
        )
      )
    ),
    ...section(
      "Relocations",
      plan.relocations.map(
        (r) =>
          `${r.granularity}/${r.strategy} ${r.sourceModule ?? r.sourcePackage} → ${r.targetModule ?? `${r.targetPackage} (unresolved)`}${r.targetResolution === undefined ? "" : ` via ${r.targetResolution}`}: ${r.members.map((m) => `${m.symbolId.split("#").pop() ?? m.symbolId} (${m.role})`).join(", ")}${r.closure === undefined ? "" : `; needs ${r.closure.externalDependencies.length === 0 ? "nothing" : r.closure.externalDependencies.map((x) => `${x.name} (${x.class}${x.typeOnly ? ", type" : ""})`).join(", ")}${r.closure.requiredInternalSymbols.length === 0 ? "" : `; moves with ${r.closure.requiredInternalSymbols.map((s) => s.split("#").pop() ?? s).join(", ")}`}${r.closure.complete ? "" : `; shares ${r.closure.sharedInternalSymbols.map((s) => s.split("#").pop() ?? s).join(", ")}`}`}`
      )
    ),
    ...section(
      "Realizes",
      plan.realizations.map(
        (r) =>
          `${r.actionId} (${r.status}${r.transformations.length === 0 ? "" : `: ${refs(r.transformations)}`})${r.detail === undefined || r.status === "realized" ? "" : ` ${r.detail}`}`
      )
    ),
    ...section(
      "Preserve",
      plan.preserved.map(
        (p) =>
          `${p.preservationId} (${p.status}${p.transformations.length === 0 ? "" : `: ${refs(p.transformations)}`})`
      )
    ),
    ...section(
      "Expected",
      plan.predicted.map(
        (e) =>
          `${e.dimension} ${e.change} of ${e.subjects.join(", ")} → ${fact(e.predicted)} (${e.certainty}${e.sourceTransformations.length === 0 ? "" : `: ${refs(e.sourceTransformations)}`})`
      )
    ),
    "",
    "Blockers",
    ...(plan.blockers.length === 0
      ? ["  none"]
      : plan.blockers.map((b) => `  ${b.kind}: ${b.detail}`)),
    ...section(
      "Conflicts",
      plan.conflicts.map((c) => `${c.kind}: ${c.detail}`)
    ),
    ...section(
      "Unresolved",
      plan.unresolved.map((g) => `${g.kind}: ${g.detail}`)
    ),
    ...section(
      "Verify",
      plan.verification.map(
        (v) =>
          `${v.kind} ${v.scope.join(", ")} → ${fact(v.expected)}${v.dependsOn.length === 0 ? "" : ` (after ${v.dependsOn.length} step${v.dependsOn.length === 1 ? "" : "s"})`}`
      )
    ),
    ...section("Forms", [
      ...d.sourceForms.map((f) => `${f.form} ×${f.count}`),
      ...(d.unsupportedForms.length === 0
        ? []
        : [`unsupported: ${d.unsupportedForms.join(", ")}`]),
    ]),
    "",
    "Identity",
    `  ${plan.id}`,
    `  fingerprint ${plan.fingerprint.hash} over ${plan.fingerprint.files.length} file${plan.fingerprint.files.length === 1 ? "" : "s"}`,
  ];
  if (validation !== undefined) {
    lines.push(
      ...section("Validation", [
        validation.status,
        ...validation.problems,
        ...validation.changedFiles.map((f) => `changed: ${f}`),
        ...(validation.currentFingerprint === undefined
          ? []
          : [`current fingerprint ${validation.currentFingerprint}`]),
      ])
    );
  }
  return lines.join("\n");
}
