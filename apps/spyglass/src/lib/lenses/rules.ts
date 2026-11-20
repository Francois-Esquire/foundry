import { covers } from "../facet-cover";
import type { Rule } from "../rule-declaration";
import { canonicalRules } from "../rules";
import type { PlanStatus } from "../types";
import { byId } from "../workspace-projection";
import type { Lens, LensReader } from "./lens-types";
import { WORKSPACE_ROOT } from "./paths";
import type { PlacesSource } from "./places";
import {
  kindOf,
  packageRoots,
  packagesNamedBySymbols,
  placesOf,
  readSymbols,
} from "./places";
import type { RuleMissing, RuleViolation } from "./rules-types";
import { RULES_SCHEMA_VERSION } from "./rules-types";

interface RulesSourcePackage {
  id: string;
  path: string;
  status: "complete" | "failed";
}

interface RulesSourceReport {
  id: string;
  opportunities: { id: string; place: string }[];
  plans: { blockers: string[]; id: string; status: PlanStatus }[];
}

export interface RulesSource extends PlacesSource {
  listed: RulesSourcePackage[];
  reports: RulesSourceReport[];
}

const NOTHING_DECLARED: RulesSource = {
  files: [],
  listed: [],
  packages: [],
  reports: [],
  symbols: [],
};

function meets(subject: string, root: string): boolean {
  if (root === "" || root === WORKSPACE_ROOT) {
    return true;
  }
  const [path = subject] = subject.split("#");
  return covers(subject, root) || covers(root, path);
}

async function readReport(
  reader: LensReader,
  id: string
): Promise<RulesSourceReport> {
  const report = await reader.packageReport(id);
  return {
    id,
    opportunities: report.opportunities
      .filter((opportunity) => opportunity.operation === "internalize-symbol")
      .map((opportunity) => ({
        id: opportunity.id,
        place: opportunity.subject.id,
      })),
    plans: report.plans
      .filter((plan) => plan.operation === "internalize-symbol")
      .map((plan) => ({
        blockers: [...new Set(plan.blockers.map((b) => b.reason))].sort(byId),
        id: plan.id,
        status: plan.status,
      })),
  };
}

function violationsIn(
  rule: Rule,
  index: number,
  report: RulesSourceReport
): RuleViolation[] {
  const plans = new Map(report.plans.map((plan) => [plan.id, plan]));
  return report.opportunities
    .filter((opportunity) => covers(rule.subject, opportunity.place))
    .map((opportunity) => {
      const plan = plans.get(`plan:${opportunity.id}`);
      return {
        opportunity: opportunity.id,
        package: report.id,
        place: opportunity.place,
        ...(plan !== undefined && { plan }),
        rule: index,
      };
    });
}

export const rulesLens: Lens<"rules", RulesSource, "rules"> = {
  derive: (source, { rules }) => {
    const places = placesOf(source);
    const missing: RuleMissing[] = [];
    const violations: RuleViolation[] = [];
    const unmatched: number[] = [];
    for (const [index, rule] of rules.entries()) {
      if (kindOf(rule.subject, places) === undefined) {
        unmatched.push(index);
      }
      if (rule.effect !== "require") {
        continue;
      }
      const met = source.listed.filter((pkg) => meets(rule.subject, pkg.path));
      for (const pkg of met.filter((p) => p.status === "failed")) {
        missing.push({ package: pkg.id, rule: index });
      }
      for (const report of source.reports) {
        if (met.some((pkg) => pkg.id === report.id)) {
          violations.push(...violationsIn(rule, index, report));
        }
      }
    }
    return {
      missing: missing.sort(
        (a, b) => a.rule - b.rule || byId(a.package, b.package)
      ),
      rules: canonicalRules(rules),
      unmatched,
      violations: violations.sort(
        (a, b) =>
          a.rule - b.rule ||
          byId(a.place, b.place) ||
          byId(a.package, b.package)
      ),
    };
  },
  id: "rules",
  read: async (reader, { rules }) => {
    if (rules.length === 0) {
      return NOTHING_DECLARED;
    }
    const all = reader.packages();
    const listed = all.map(({ id, path, status }) => ({ id, path, status }));
    const required = rules.filter((rule) => rule.effect === "require");
    const reports: RulesSourceReport[] = [];
    for (const pkg of listed) {
      if (
        pkg.status === "complete" &&
        required.some((rule) => meets(rule.subject, pkg.path))
      ) {
        reports.push(await readReport(reader, pkg.id));
      }
    }
    const index = await reader.moduleIndex();
    return {
      files: index.modules.map((module) => module.id),
      listed,
      packages: packageRoots(all),
      reports,
      symbols: await readSymbols(
        reader,
        packagesNamedBySymbols(
          all,
          rules.map((rule) => rule.subject)
        )
      ),
    };
  },
  schemaVersion: RULES_SCHEMA_VERSION,
  settings: ["rules"],
};
