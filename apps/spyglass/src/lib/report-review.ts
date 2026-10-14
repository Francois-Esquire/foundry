import type {
  FamilyReviewDisposition,
  PackageArchitectureReview,
  ReviewedEffectDimension,
  ReviewedRewiringScenario,
  ReviewMeasure,
  ScenarioFamilyReview,
} from "./architecture-review-types";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  InternalRewiringReport,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
} from "./internal-rewiring-types";
import { count, plural } from "./render/format";

const wordsPattern = /([A-Z])/g;
const variantPattern = /^(partial|full):/;
const shortIdPattern = /^responsibility:/;

// V13.5 CLI view of the architecture review. Disposition counts, dominance
// and tradeoff frequencies, then one section per disposition with the
// families themselves: every scenario with the dimensions it changes, raw
// before and after, certainty where it is not measured, what it preserves,
// and any dominance stated as the comparison it came from. Nothing is
// ranked; sections order by subject size and id.

const KIND_LABELS: Record<InternalRewiringScenarioKind, string> = {
  "align-with-convention": "align with convention",
  "collapse-indirection": "collapse indirection",
  "colocate-primitive": "colocate primitive",
  "demote-primitive": "demote primitive",
  "formalize-cross-responsibility-contract": "formalize contract",
  "formalize-responsibility-surface": "formalize surface",
  "preserve-composition-root": "preserve composition root",
  "preserve-cross-responsibility-contract": "preserve contract",
  "preserve-current": "preserve current",
  "preserve-package-primitive": "preserve package primitive",
  "promote-primitive": "promote primitive",
  "redirect-internal-dependency": "redirect dependency",
  "split-module-by-responsibility": "split by responsibility",
  "split-module-by-role": "split by role",
};

const DISPOSITION_LABELS: Record<FamilyReviewDisposition, string> = {
  "credible-alternative": "credible alternative",
  "insufficient-evidence": "insufficient evidence",
  "multiple-tradeoffs": "multiple tradeoffs",
  "preservation-required": "preservation required",
  "preserve-current": "preserve current",
  "uncertainty-blocked": "uncertainty blocked",
};

function shortId(id: string | undefined): string {
  return id === undefined ? "—" : id.replace(shortIdPattern, "");
}

function symbolName(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash === -1 ? id : id.slice(hash + 1);
}

function label(scenario: InternalRewiringScenario | undefined): string {
  if (scenario === undefined) {
    return "—";
  }
  const variant = scenario.rationale.facts
    .map((f) => variantPattern.exec(f)?.[1])
    .find((v) => v !== undefined);
  return `${KIND_LABELS[scenario.kind]}${variant === undefined ? "" : ` (${variant})`}`;
}

function subjectLines(family: ScenarioFamilyReview): string[] {
  const { subject } = family;
  if (subject.kind === "symbol-group") {
    const ids = subject.symbolIds ?? [];
    const names = ids.slice(0, 4).map(symbolName).join(", ");
    return [
      `  ${ids.length === 1 ? "SYMBOL" : "SYMBOLS"} ${names}${ids.length > 4 ? ` +${count(ids.length - 4)}` : ""}`,
      `  ${subject.module ?? ""}`,
    ];
  }
  if (subject.kind === "module") {
    return [`  MODULE ${subject.module ?? ""}`];
  }
  if (subject.kind === "responsibility-relationship") {
    return [
      `  RELATIONSHIP ${shortId(subject.relationship?.from)} → ${shortId(subject.relationship?.to)}`,
    ];
  }
  return [
    `  DEPENDENCY ${plural(subject.edges?.length ?? 0, "edge")} into ${subject.module ?? ""}`,
  ];
}

function measureText(m: ReviewMeasure): string {
  if (m.name === "alignedSymbols") {
    return `${m.delta > 0 ? "+" : ""}${count(m.delta)} aligned symbols`;
  }
  if (m.name === "movedSymbols") {
    return plural(m.after, "symbol");
  }
  if (m.name === "blockers") {
    return plural(m.after, "blocker");
  }
  if (m.name === "required") {
    return `${count(m.after)} required`;
  }
  if (m.name === "optional") {
    return `${count(m.after)} optional`;
  }
  if (m.name === "cycleRisk") {
    if (m.delta < 0) {
      return "leaves its cycle";
    }
    if (m.delta > 0) {
      return "potential new cycle";
    }
    return "cycle unchanged";
  }
  if (m.name === "conventionMatch") {
    if (m.after === 2) {
      return "matches convention";
    }
    if (m.after === 0) {
      return "differs from convention";
    }
    return "no decisive convention";
  }
  const words = m.name.replace(wordsPattern, " $1").toLowerCase();
  return m.before === m.after
    ? `${words} ${count(m.after)}`
    : `${words} ${count(m.before)} → ${count(m.after)}`;
}

function dimensionLine(d: ReviewedEffectDimension): string | undefined {
  const shown = d.measures.filter((m) => m.delta !== 0);
  if (shown.length === 0 && d.certainty === "measured") {
    return undefined;
  }
  const parts = shown.map(measureText);
  const certainty =
    d.certainty === "measured"
      ? ""
      : ` (${d.certainty}: ${d.conditions.map((c) => c.split(":")[0] ?? c).join(", ")})`;
  return `      ${d.dimension.padEnd(26)} ${parts.join(" · ") || "unchanged"}${certainty}`;
}

function scenarioLines(
  reviewed: ReviewedRewiringScenario,
  scenario: InternalRewiringScenario | undefined,
  byId: Map<string, InternalRewiringScenario>
): string[] {
  const lines: string[] = [];
  lines.push(`    ${label(scenario).toUpperCase()} · ${reviewed.status}`);
  if (
    scenario !== undefined &&
    scenario.proposed.scope !== "unchanged" &&
    reviewed.status !== "preservation"
  ) {
    const target =
      scenario.proposed.candidateModules.length > 0
        ? `existing: ${scenario.proposed.candidateModules.map((c) => c.module).join(", ")}`
        : "no existing target module";
    lines.push(
      `      proposed                   ${scenario.proposed.scope}${scenario.proposed.responsibility === undefined ? "" : ` ${shortId(scenario.proposed.responsibility)}`} · ${target}`
    );
  }
  scenarioLinesEntries(reviewed, scenario, lines);
  for (const d of reviewed.effects) {
    const line = dimensionLine(d);
    if (line !== undefined) {
      lines.push(line);
    }
  }
  if (reviewed.preservation.kept.length > 0) {
    lines.push(
      `      preserves                  ${reviewed.preservation.kept.join(", ")}${reviewed.preservation.missing.length > 0 ? ` · gives up ${reviewed.preservation.missing.join(", ")}` : ""}`
    );
  }
  if (reviewed.uncertainty.standing.length > 0) {
    lines.push(
      `      recorded                   ${reviewed.uncertainty.standing.join(", ")}`
    );
  }
  if (reviewed.dominatedBy.length > 0) {
    lines.push(
      `      dominated by               ${reviewed.dominatedBy.map((id) => label(byId.get(id))).join(", ")}`
    );
  }
  return lines;
}

function scenarioLinesEntries(
  reviewed: ReviewedRewiringScenario,
  scenario: InternalRewiringScenario | undefined,
  lines: string[]
) {
  if (reviewed.status === "preservation" && scenario !== undefined) {
    const c = scenario.current;
    lines.push(
      `      keeps                      ${[
        c.scope === undefined ? undefined : `scope ${c.scope}`,
        c.roles === undefined
          ? undefined
          : Object.entries(c.roles)
              .map(([role, n]) => `${count(n)} ${role}`)
              .join(", "),
        c.consumerModules !== undefined &&
        c.consumerResponsibilities !== undefined
          ? `${plural(c.consumerModules, "consumer")} in ${plural(c.consumerResponsibilities.length, "responsibility")}`
          : undefined,
        c.compositionRoles === undefined
          ? undefined
          : `composition: ${c.compositionRoles.join(", ")}`,
      ]
        .filter((part) => part !== undefined)
        .join(" · ")}`
    );
  }
}

function familyLines(
  family: ScenarioFamilyReview,
  review: PackageArchitectureReview,
  byId: Map<string, InternalRewiringScenario>
): string[] {
  const lines = subjectLines(family);
  const reviewed = review.scenarios.filter((s) => s.familyId === family.id);
  lines.push(
    `  scenarios   ${family.scenarios.map((id) => label(byId.get(id))).join(" · ")}`
  );
  lines.push(
    `  review      ${DISPOSITION_LABELS[family.disposition]}${family.preservationRequirements.length > 0 ? ` · requires ${family.preservationRequirements.join(", ")}` : ""}`
  );
  for (const reason of family.reasons) {
    lines.push(`              ${reason}`);
  }
  for (const relation of family.dominance) {
    lines.push(
      `  dominance   ${label(byId.get(relation.dominated))} is dominated by ${label(byId.get(relation.dominant))}: no worse on every comparable measured dimension and better on ${relation.improves.join(", ")}`
    );
  }
  if (family.nondominated.length > 1 && family.dominance.length === 0) {
    lines.push(
      "  dominance   no scenario dominates the others on all certain dimensions"
    );
  }
  for (const r of reviewed) {
    if (r.status === "baseline") {
      continue;
    }
    lines.push(...scenarioLines(r, byId.get(r.scenarioId), byId));
  }
  return lines;
}

export function renderPackageArchitectureReview(
  review: PackageArchitectureReview,
  rewiring: InternalRewiringReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const byId = new Map(
    rewiring.scenarios.map((scenarioReview2) => [
      scenarioReview2.id,
      scenarioReview2,
    ])
  );
  const { summary } = review;
  const limits = config.internalReview.report;
  const lines: string[] = [];
  lines.push("PACKAGE ARCHITECTURE REVIEW");
  lines.push("═".repeat(27));
  lines.push(`Package  ${review.package.id}`);
  lines.push(
    "Rules    dominance only over measured differences · unresolved dimensions block both ways · required preservations block one way · convention supporting only · no score, no ranking"
  );
  lines.push("");
  const d = summary.families.byDisposition;
  lines.push(
    `Families     ${count(summary.families.total)} · ${review.policy.dispositions
      .map((k) => `${DISPOSITION_LABELS[k]} ${count(d[k])}`)
      .join(" · ")}`
  );
  const s = summary.scenarios.byStatus;
  lines.push(
    `Scenarios    ${count(summary.scenarios.total)} · ${review.policy.statuses
      .filter((k) => s[k] > 0)
      .map((k) => `${k} ${count(s[k])}`)
      .join(" · ")}`
  );
  const dom = summary.dominance;
  lines.push(
    `Dominance    baseline over alternative ${count(dom.baselineOverAlternative)} · alternative over baseline ${count(dom.alternativeOverBaseline)} · alternative over alternative ${count(dom.alternativeOverAlternative)} · no dominance ${plural(dom.noDominance, "pair")}`
  );
  lines.push(
    `Tradeoffs    ${
      summary.tradeoffPairs
        .slice(0, 5)
        .map((p) => `${p.dimensions.join(" ↔ ")} ${count(p.count)}`)
        .join(" · ") || "none"
    }`
  );
  lines.push(
    `Preserved    ${
      Object.entries(summary.preservationReasons)
        .map(([k, n]) => `${k} ${count(n)}`)
        .join(" · ") || "none"
    } · ${plural(summary.compositionRootsPreserved, "composition root")}`
  );
  lines.push(
    `Closure      ${Object.entries(summary.closureByStatus)
      .map(
        ([currentSize, statuses]) =>
          `${currentSize}: ${
            Object.entries(statuses)
              .map(([k, n]) => `${k} ${count(n)}`)
              .join(", ") || "—"
          }`
      )
      .join(" · ")}`
  );
  lines.push(
    `Uncertain    ${
      Object.entries(summary.uncertaintyReasons)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 6)
        .map(([k, n]) => `${k} ${count(n)}`)
        .join(" · ") || "none"
    }`
  );
  lines.push(
    `Sizes        ${Object.entries(summary.familySizes)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} scenarios: ${count(n)}`)
      .join(
        " · "
      )} · ${plural(summary.lowUncertaintyAlternatives.length, "low-uncertainty alternative")} · ${plural(summary.highUncertaintyAlternatives.length, "high-uncertainty alternative")} · ${plural(summary.complexSubjects.length, "complex subject")}`
  );

  const size = (family: ScenarioFamilyReview) =>
    family.subject.symbolIds?.length ?? family.subject.edges?.length ?? 0;
  const section = (
    title: string,
    disposition: FamilyReviewDisposition,
    limit: number = limits.topFamilies
  ) => {
    const matching = review.families
      .filter((f) => f.disposition === disposition)
      .sort(
        (a, b) =>
          b.scenarios.length - a.scenarios.length ||
          size(b) - size(a) ||
          a.id.localeCompare(b.id)
      );
    if (matching.length === 0) {
      return;
    }
    lines.push("");
    lines.push(`${title} (${count(matching.length)})`);
    for (const family of matching.slice(0, limit)) {
      lines.push("");
      lines.push(...familyLines(family, review, byId));
    }
  };
  section("MULTIPLE TRADEOFFS", "multiple-tradeoffs");
  section("CREDIBLE ALTERNATIVES", "credible-alternative");
  section("PRESERVATIONS", "preservation-required");
  section("PRESERVE CURRENT", "preserve-current");
  section("UNCERTAIN REVIEWS", "uncertainty-blocked");

  const dominated = review.scenarios.filter((r) => r.status === "dominated");
  if (dominated.length > 0) {
    lines.push("");
    lines.push(`DOMINATED ALTERNATIVES (${count(dominated.length)})`);
    for (const r of dominated.slice(0, limits.topFamilies)) {
      const family = review.families.find((f) => f.id === r.familyId);
      lines.push(
        `  ${label(byId.get(r.scenarioId))} · ${family?.subject.key ?? r.familyId} · dominated by ${r.dominatedBy.map((id) => label(byId.get(id))).join(", ")}`
      );
    }
  }

  const complex = review.subjects
    .filter((scenarioReview) => scenarioReview.complex)
    .sort(
      (a, b) =>
        b.complexity.nondominatedAlternatives -
          a.complexity.nondominatedAlternatives ||
        b.complexity.changingDimensions - a.complexity.changingDimensions ||
        a.subject.key.localeCompare(b.subject.key)
    );
  if (complex.length > 0) {
    lines.push("");
    lines.push(`COMPLEX REVIEW SUBJECTS (${count(complex.length)})`);
    const visitSubject = () => {
      for (const subject of complex.slice(0, limits.topSubjects)) {
        const c = subject.complexity;
        lines.push(
          `  ${subject.subject.key} · ${count(c.families)} ${c.families === 1 ? "family" : "families"} · ${count(c.nondominatedAlternatives)} of ${plural(c.alternatives, "alternative")} nondominated · ${plural(c.changingDimensions, "dimension")} changing${c.largestClosure === undefined ? "" : ` · largest closure ${c.largestClosure}`}${c.scopeGroups === undefined ? "" : ` · ${plural(c.scopeGroups, "scope group")}`}`
        );
      }
    };
    visitSubject();
  }

  const insufficient = summary.insufficientEvidenceReasons.slice(0, 5);
  if (insufficient.length > 0) {
    lines.push("");
    lines.push(
      `INSUFFICIENT EVIDENCE (${count(d["insufficient-evidence"])} subjects)`
    );
    for (const entry of insufficient) {
      lines.push(`  ${count(entry.count)} × ${entry.reason}`);
    }
  }
  return lines.join("\n");
}
