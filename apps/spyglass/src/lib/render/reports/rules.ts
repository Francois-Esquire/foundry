import type { Rules, RuleViolation } from "../../lenses/rules-types";
import type { Rule } from "../../rule-declaration";
import type { RenderDensity } from "../context";
import { count } from "../format";
import type { ReportView, SectionView } from "../views";
import { blockerDefinitions } from "./explanations";
import { listSection } from "./ranked-section";

/** A rule as a line names it: `rules[0] require internalize packages/core`. */
function ruleName(rules: readonly Rule[], index: number): string {
  const rule = rules[index];
  return rule === undefined
    ? `rules[${index}]`
    : `rules[${index}] ${rule.effect} ${rule.operator} ${rule.subject}`;
}

function planText(violation: RuleViolation): string {
  const { plan } = violation;
  if (plan === undefined) {
    return "no saved plan";
  }
  return plan.blockers.length === 0
    ? `plan ${plan.status}`
    : `plan ${plan.status}: ${plan.blockers.join(", ")}`;
}

/** One section per broken rule, its places by path. */
function violationSections(lens: Rules, density: RenderDensity): SectionView[] {
  const broken = [...new Set(lens.violations.map((v) => v.rule))];
  return broken.flatMap((index) => {
    const section = listSection(
      lens.violations
        .filter((violation) => violation.rule === index)
        .map(
          (violation) =>
            `${violation.place} · ${violation.package} · ${planText(violation)}`
        ),
      density,
      `Breaks ${ruleName(lens.rules, index)}`
    );
    return section === undefined ? [] : [section];
  });
}

/** What each blocker reason among the violations' plans means, as the package report defines it. */
function blockerNote(lens: Rules): SectionView | undefined {
  const lines = blockerDefinitions(
    [...new Set(lens.violations.flatMap((v) => v.plan?.blockers ?? []))].sort()
  );
  if (lines.length === 0) {
    return;
  }
  return {
    blocks: [{ kind: "note", lines, title: "Why a plan is blocked" }],
  };
}

/** The `rules` lens: counts, each broken rule's places, why their plans are blocked, then what was not checked. */
export function buildRulesView(
  lens: Rules,
  density: RenderDensity
): ReportView {
  if (lens.rules.length === 0) {
    return {
      sections: [
        {
          blocks: [
            {
              kind: "text",
              lines: [
                "No rules declared. Declare them under rules in .foundry/spyglass/.",
              ],
            },
          ],
        },
      ],
      title: "Rules",
    };
  }
  const required = lens.rules.filter((rule) => rule.effect === "require");
  const sections: SectionView[] = [
    {
      blocks: [
        {
          kind: "labelValue",
          rows: [
            {
              label: "Rules",
              value: `${count(lens.rules.length)} (${count(required.length)} require, ${count(lens.rules.length - required.length)} permit)`,
            },
            { label: "Violations", value: count(lens.violations.length) },
            { label: "Unmatched", value: count(lens.unmatched.length) },
            { label: "Not checked", value: count(lens.missing.length) },
          ],
        },
      ],
    },
    ...violationSections(lens, density),
  ];
  const rest = [
    blockerNote(lens),
    listSection(
      lens.unmatched.map(
        (index) =>
          `${ruleName(lens.rules, index)}: names no place in the dataset`
      ),
      density,
      "Unmatched rules"
    ),
    listSection(
      lens.missing.map(
        ({ package: pkg, rule }) =>
          `${ruleName(lens.rules, rule)}: ${pkg} failed analysis, so the rule was not checked there`
      ),
      density,
      "Not checked"
    ),
  ];
  for (const section of rest) {
    if (section !== undefined) {
      sections.push(section);
    }
  }
  return { sections, title: "Rules" };
}
