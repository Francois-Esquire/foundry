import type { OperatorPlanReadiness } from "./operator-readiness-types";

const linesPattern = /-/g;

// Text view over a readiness record. Reads the record only; derives nothing.

function heading(title: string): string[] {
  return [title, "═".repeat(title.length)];
}

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  return ["", title, ...lines.map((line) => `  ${line}`)];
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

export function renderOperatorPlanReadiness(
  readiness: OperatorPlanReadiness
): string {
  const r = readiness;
  const s = r.sourceState;
  const c = r.completeness;
  const files = s.expectedFiles.length;
  const manifests = s.expectedManifests.length;
  const lines = [
    ...heading("OPERATOR READINESS"),
    ...section("Plan", [r.planId, `fingerprint ${r.planFingerprint}`]),
    ...section("Source", [
      s.unchanged ? "current" : "changed",
      `${files} file${files === 1 ? "" : "s"} verified`,
      `${manifests} manifest${manifests === 1 ? "" : "s"} verified`,
      ...s.staleFiles.map((f) => `changed: ${f}`),
      ...s.missingFiles.map((f) => `missing: ${f}`),
      ...s.unexpectedFiles.map((f) => `already exists: ${f}`),
      ...(s.git.available
        ? [
            `git: ${s.git.plannedDirty.length} planned dirty, ${s.git.unplannedDirty} unplanned dirty`,
          ]
        : ["git: unavailable"]),
    ]),
    ...section("Completeness", [
      `${c.realizedActions} / ${c.requiredActions} actions realized`,
      `${c.coveredPreservations} / ${c.preservations} preservations covered`,
      `${c.coveredEffects} / ${c.expectedEffects} expected effects covered`,
      `${c.plannedVerificationRequirements} / ${c.verificationRequirements} verification requirements resolved`,
      ...c.conditionalTransformations.map(
        (t) => `conditional ${t.transformationId}: ${t.resolution}`
      ),
      ...c.unresolvedGaps.map((g) => `gap: ${g}`),
    ]),
    ...section(
      "Consistency",
      Object.entries(r.consistency)
        .filter(([key]) => key !== "consistent")
        .map(([key, value]) => `${pad(key, 26)} ${value ? "ok" : "FAIL"}`)
    ),
    ...section(
      "Constraints",
      r.constraints.checks.map(
        (k) => `${pad(k.kind, 26)} ${pad(k.status, 15)} ${k.detail}`
      )
    ),
    ...section(
      "Mutation support",
      r.realizability.mutationCapabilities.map(
        (m) =>
          `${pad(`${m.transformationKind} (${m.form})`, 44)} ${m.supported ? "supported" : "unsupported"}${m.supported && !m.reversible ? ", irreversible" : ""} ×${m.occurrences}`
      )
    ),
    ...section(
      "Preservation",
      r.preservation.preservations.map(
        (p) => `${pad(p.preservationId, 44)} ${p.status}`
      )
    ),
    ...section(
      "Verification",
      r.verification.steps.map(
        (v) =>
          `${pad(v.kind, 24)} ${v.mode === "command" && v.command !== undefined ? `${v.command.executable} ${v.command.args.join(" ")} (${v.command.cwd})` : (v.query ?? v.detail ?? v.mode)}`
      )
    ),
    ...section(
      "Baseline",
      r.verification.baselineChecks.map(
        (b) => `${pad(b.kind, 24)} ${pad(b.status, 16)} ${b.detail}`
      )
    ),
    ...section("Rollback", [
      `${r.rollback.files.length + r.rollback.manifests.length} file${r.rollback.files.length + r.rollback.manifests.length === 1 ? "" : "s"} ${r.rollback.complete ? "snapshottable" : "not all restorable"}`,
      ...r.rollback.createdFiles.map((f) => `create: ${f}`),
      ...r.rollback.deletedFiles.map((f) => `delete: ${f}`),
      r.rollback.complete ? "complete" : "incomplete",
    ]),
    ...section(
      "Risks",
      r.risks.map(
        (k) => `${k.kind}${k.blocking ? " (blocking)" : ""}: ${k.detail}`
      )
    ),
    "",
    "Blockers",
    ...(r.blockers.length === 0
      ? ["  none"]
      : r.blockers.map((b) => `  ${b.kind}: ${b.detail}`)),
    ...section(
      "Cautions",
      r.cautions.map((k) => `${k.kind}: ${k.detail}`)
    ),
    "",
    "Authorization",
    `  ${r.authorization.toUpperCase().replace(linesPattern, " ")}`,
    "",
    "Fingerprint",
    `  ${r.fingerprint.hash}`,
    "  V12 must revalidate this fingerprint before its first write.",
  ];
  return lines.join("\n");
}
