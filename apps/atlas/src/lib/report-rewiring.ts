import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  BeforeAfter,
  InternalRewiringReport,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
} from "./internal-rewiring-types";
import { count, plural } from "./render/format";

// V13.4 CLI view of internal rewiring scenarios. Counts by kind and family,
// composition evidence, then one section per scenario shape with the
// strongest examples: current arrangement, proposed scope, simulated
// effects, evidence, uncertainties. The JSON carries every scenario.

const KIND_LABELS: Record<InternalRewiringScenarioKind, string> = {
  "align-with-convention": "align with convention",
  "collapse-indirection": "collapse indirection",
  "colocate-primitive": "colocate primitive",
  "demote-primitive": "demote primitive",
  "formalize-cross-responsibility-contract":
    "formalize cross-responsibility contract",
  "formalize-responsibility-surface": "formalize responsibility surface",
  "preserve-composition-root": "preserve composition root",
  "preserve-cross-responsibility-contract":
    "preserve cross-responsibility contract",
  "preserve-current": "preserve current",
  "preserve-package-primitive": "preserve package primitive",
  "promote-primitive": "promote primitive",
  "redirect-internal-dependency": "redirect internal dependency",
  "split-module-by-responsibility": "split module by responsibility",
  "split-module-by-role": "split module by role",
};

function shortId(id: string | undefined): string {
  return id === undefined ? "—" : id.replace(/^responsibility:/, "");
}

function symbolName(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash === -1 ? id : id.slice(hash + 1);
}

function delta(value: BeforeAfter): string {
  return value.before === value.after
    ? `${count(value.before)} (unchanged)`
    : `${count(value.before)} → ${count(value.after)}`;
}

function responsibilities(value: number): string {
  return `${count(value)} ${value === 1 ? "responsibility" : "responsibilities"}`;
}

function subjectLine(scenario: InternalRewiringScenario): string {
  const subject = scenario.subject;
  if (subject.kind === "symbol-group") {
    const ids = subject.symbolIds ?? [];
    const names = ids.slice(0, 4).map(symbolName).join(", ");
    return `${names}${ids.length > 4 ? ` +${count(ids.length - 4)}` : ""} · ${subject.module ?? ""}`;
  }
  if (subject.kind === "module") {
    return subject.module ?? "";
  }
  if (subject.kind === "responsibility-relationship") {
    return `${shortId(subject.relationship?.from)} → ${shortId(subject.relationship?.to)}`;
  }
  return `${plural(subject.edges?.length ?? 0, "edge")} into ${subject.module ?? ""}`;
}

function renderScenario(
  scenario: InternalRewiringScenario,
  lines: string[]
): void {
  const { current, proposed, effects } = scenario;
  lines.push(`  ${KIND_LABELS[scenario.kind].toUpperCase()}`);
  lines.push(`  ${subjectLine(scenario)}`);
  const currentParts = [
    current.moduleStatus === undefined
      ? undefined
      : `declaring module ${current.moduleStatus}${current.responsibility === undefined ? "" : ` in ${shortId(current.responsibility)}`}`,
    current.scope === undefined ? undefined : `scope ${current.scope}`,
    current.roles === undefined
      ? undefined
      : Object.entries(current.roles)
          .map(([role, n]) => `${count(n)} ${role}`)
          .join(", "),
    current.consumerResponsibilities !== undefined &&
    current.consumerModules !== undefined
      ? `${plural(current.consumerModules, "consumer")} in ${responsibilities(current.consumerResponsibilities.length)}${(current.unresolvedConsumers ?? 0) > 0 ? ` (+${count(current.unresolvedConsumers ?? 0)} unresolved)` : ""}`
      : undefined,
    current.scopeGroups === undefined
      ? undefined
      : plural(current.scopeGroups.length, "scope group"),
    current.relationship === undefined
      ? undefined
      : `${plural(current.relationship.sourceModules, "module")} reach ${plural(current.relationship.targetModules, "module")} with ${plural(current.relationship.symbolFlow, "symbol")}`,
    current.compositionRoles === undefined
      ? undefined
      : `composition: ${current.compositionRoles.join(", ")}`,
  ].filter((part): part is string => part !== undefined);
  lines.push(`    current    ${currentParts.join(" · ")}`);
  const proposedParts = [
    proposed.scope === "unchanged"
      ? "unchanged"
      : `${proposed.scope}${proposed.responsibility === undefined ? "" : ` ${shortId(proposed.responsibility)}`}`,
    proposed.separated === undefined
      ? undefined
      : `separate ${proposed.separated
          .map((g) =>
            "role" in g
              ? `${count(g.symbolIds.length)} ${g.role}`
              : `${count(g.symbolIds.length)} ${g.key.replace(/^responsibility-local:responsibility:/, "local to ")}`
          )
          .join(", ")}`,
    proposed.remainder === undefined
      ? undefined
      : `keep ${proposed.remainder
          .map(
            (g) =>
              `${count(g.symbolIds.length)} ${g.key.replace(/^responsibility-local:responsibility:/, "local to ")}`
          )
          .join(", ")}`,
    proposed.surface === undefined
      ? undefined
      : `${plural(proposed.surface.consumerModules.length, "consumer")} · ${plural(proposed.surface.deepModules.length, "deep module")} · ${plural(proposed.surface.symbolIds.length, "symbol")}`,
    proposed.collapse === undefined
      ? undefined
      : `${proposed.collapse.consumer} depends on ${proposed.collapse.providers.join(", ")} directly`,
    proposed.candidateModules.length > 0
      ? `existing: ${proposed.candidateModules
          .map((c) => `${c.module} (${c.evidence.join(", ")})`)
          .join("; ")}`
      : proposed.scope === "unchanged"
        ? undefined
        : "no existing target module",
  ].filter((part): part is string => part !== undefined);
  lines.push(`    proposed   ${proposedParts.join(" · ")}`);
  if (scenario.kind !== "preserve-current") {
    const b = effects.responsibilityBoundaries;
    const effectParts = [
      `cross-responsibility edges ${delta(b.crossEdges)}`,
      `unresolved edges ${delta(b.unresolvedEdges)}`,
      `within edges ${delta(b.withinEdges)}`,
      ...(effects.dependencies.deepImports === undefined
        ? []
        : [`deep imports ${delta(effects.dependencies.deepImports)}`]),
      ...(effects.dependencies.modules[0] === undefined
        ? []
        : [`fan-in ${delta(effects.dependencies.modules[0].fanIn)}`]),
      `scope groups ${delta(effects.moduleComposition.scopeGroups)}`,
      `modules ${delta(effects.moduleComposition.modules)}`,
      effects.locality.before === effects.locality.after
        ? undefined
        : `locality ${effects.locality.before} → ${effects.locality.after}`,
      `cycles ${effects.cycles.outcome}`,
      effects.conventions.alignment,
    ].filter((part): part is string => part !== undefined);
    lines.push(`    effects    ${effectParts.join(" · ")}`);
    if (scenario.closure !== undefined) {
      const c = scenario.closure;
      lines.push(
        `    closure    ${c.size}${c.required.length > 0 ? ` · ${plural(c.required.length, "required")}` : ""}${c.optional.length > 0 ? ` · ${plural(c.optional.length, "optional")}` : ""}${c.blockers.length > 0 ? ` · ${plural(c.blockers.length, "blocker")}` : ""}`
      );
    }
    lines.push(`    evidence   ${scenario.rationale.facts.join(" · ")}`);
    if (scenario.preservations.length > 0) {
      lines.push(`    preserves  ${scenario.preservations.join(", ")}`);
    }
    if (scenario.uncertainties.length > 0) {
      lines.push(
        `    uncertain  ${scenario.uncertainties.map((u) => u.reason).join(", ")}`
      );
    }
  }
}

export function renderInternalRewiring(
  report: InternalRewiringReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { summary, policy } = report;
  const limits = config.internalRewiring.report;
  const lines: string[] = [];
  lines.push("INTERNAL REWIRING SCENARIOS");
  lines.push("═".repeat(27));
  lines.push(`Package  ${report.package.id}`);
  lines.push(
    `Rules    composition root at ${responsibilities(policy.compositionRoot.minimumResponsibilities)}, ≤${count(policy.compositionRoot.maximumExportedSymbols)} exports, ${count(policy.compositionRoot.minimumWiringSites)}+ wiring sites · split groups of ${count(policy.split.minimumGroupSymbols)}+ · surface at ${count(policy.surface.minimumTargetModules)}+ deep modules · no ranking`
  );
  lines.push("");
  lines.push(
    `Candidates   ${count(summary.candidates.total)} · ${count(summary.candidates.eligible)} eligible · ${count(summary.candidates.ineligible)} ineligible`
  );
  lines.push(
    `Scenarios    ${count(summary.scenarios)} across ${plural(summary.families.total, "subject")} · ${count(summary.families.withAlternatives)} with alternatives · ${count(summary.families.preservationOnly)} preservation-only · ${count(summary.families.insufficientEvidence)} insufficient evidence`
  );
  const k = summary.byKind;
  lines.push(
    `By kind      ${policy.kinds
      .filter((kind) => k[kind] > 0)
      .map((kind) => `${KIND_LABELS[kind]} ${count(k[kind])}`)
      .join(" · ")}`
  );
  const c = summary.composition;
  lines.push(
    `Composition  ${plural(c.modules, "module")} depend on 2+ responsibilities · ${plural(c.roots, "composition root")} · ${policy.compositionRoles
      .filter((role) => c.byRole[role] > 0)
      .map((role) => `${role} ${count(c.byRole[role])}`)
      .join(
        " · "
      )} · wide-dependent: ${count(c.wideDependents.roots)} of ${count(c.wideDependents.total)} are roots, ${count(c.wideDependents.unclear)} unclear`
  );
  const e = summary.effects;
  lines.push(
    `Effects      ${count(e.crossEdgesReduced)} scenarios reduce cross-responsibility edges · ${count(e.crossEdgesIncreased)} increase them · ${count(e.unresolvedEdgesReduced)} reduce unresolved edges · ${plural(e.localDeclarationsMoved, "local declaration")} moved · ${plural(e.packageWidePreserved, "package-wide symbol")} preserved`
  );
  const cy = summary.cycles;
  const cl = summary.closures;
  lines.push(
    `Cycles       ${count(cy.unchanged)} unchanged · ${count(cy["membership-removed"])} membership removed · ${count(cy["potential-new-cycle"])} potential new · closures: ${count(cl.independent)} independent · ${count(cl.small)} small · ${count(cl.large)} large · ${count(cl.unresolved)} blocked`
  );
  const cv = summary.conventions;
  lines.push(
    `Conventions  ${count(cv["matches-convention"])} match · ${count(cv["differs-from-convention"])} differ · ${count(cv["competing-convention"])} competing · ${count(cv["no-applicable-convention"])} none applicable`
  );
  const u = summary.byUncertainty;
  lines.push(
    `Uncertain    ${Object.entries(u)
      .filter(([, n]) => n > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6)
      .map(([reason, n]) => `${reason} ${count(n)}`)
      .join(" · ")}`
  );

  const section = (
    title: string,
    kinds: InternalRewiringScenarioKind[],
    order: (a: InternalRewiringScenario, b: InternalRewiringScenario) => number,
    limit: number = limits.topScenarios
  ) => {
    const matching = report.scenarios
      .filter((s) => kinds.includes(s.kind))
      .sort(order);
    if (matching.length === 0) {
      return;
    }
    lines.push("");
    lines.push(`${title} (${count(matching.length)})`);
    for (const scenario of matching.slice(0, limit)) {
      lines.push("");
      renderScenario(scenario, lines);
    }
  };
  const bySymbols = (
    a: InternalRewiringScenario,
    b: InternalRewiringScenario
  ) =>
    (b.subject.symbolIds?.length ?? 0) - (a.subject.symbolIds?.length ?? 0) ||
    (b.current.consumerModules ?? 0) - (a.current.consumerModules ?? 0) ||
    a.subject.key.localeCompare(b.subject.key);
  const byGroups = (a: InternalRewiringScenario, b: InternalRewiringScenario) =>
    (b.current.scopeGroups?.length ?? 0) -
      (a.current.scopeGroups?.length ?? 0) ||
    b.effects.locality.symbols - a.effects.locality.symbols ||
    a.subject.key.localeCompare(b.subject.key);
  const byReach = (a: InternalRewiringScenario, b: InternalRewiringScenario) =>
    (b.current.consumerResponsibilities?.length ?? 0) -
      (a.current.consumerResponsibilities?.length ?? 0) || bySymbols(a, b);
  const byFlow = (a: InternalRewiringScenario, b: InternalRewiringScenario) =>
    (b.current.relationship?.targetModules ?? 0) -
      (a.current.relationship?.targetModules ?? 0) ||
    (b.current.relationship?.symbolFlow ?? 0) -
      (a.current.relationship?.symbolFlow ?? 0) ||
    a.subject.key.localeCompare(b.subject.key);

  section(
    "PRIMITIVE LOCALITY",
    [
      "demote-primitive",
      "colocate-primitive",
      "promote-primitive",
      "align-with-convention",
    ],
    bySymbols
  );
  section(
    "MODULE SPLITS",
    ["split-module-by-responsibility", "split-module-by-role"],
    byGroups,
    limits.topModules
  );
  section(
    "RESPONSIBILITY SURFACES",
    [
      "formalize-responsibility-surface",
      "formalize-cross-responsibility-contract",
    ],
    byFlow
  );
  section(
    "DEPENDENCY REDIRECTS & COLLAPSES",
    ["redirect-internal-dependency", "collapse-indirection"],
    bySymbols,
    limits.topModules
  );
  section(
    "PRESERVATIONS",
    [
      "preserve-package-primitive",
      "preserve-composition-root",
      "preserve-cross-responsibility-contract",
    ],
    byReach
  );

  const unclear = report.composition.filter((entry) =>
    entry.roles.includes("unclear")
  );
  if (unclear.length > 0) {
    lines.push("");
    lines.push(
      `WIDE-DEPENDENT WITHOUT COMPOSITION EVIDENCE (${count(unclear.length)})`
    );
    for (const entry of unclear
      .sort(
        (a, b) =>
          b.responsibilities.length - a.responsibilities.length ||
          a.module.localeCompare(b.module)
      )
      .slice(0, limits.topModules)) {
      const w = entry.wiring;
      lines.push(
        `  ${entry.module} · ${responsibilities(entry.responsibilities.length)} · ${plural(entry.exportedSymbols, "export")} · wiring ${count(w.constructed)} new / ${count(w.called)} call / ${count(w.argument)} arg / ${count(w.collected)} collect / ${count(w.rendered)} jsx over ${responsibilities(entry.wiredResponsibilities.length)}`
      );
    }
  }
  return lines.join("\n");
}
