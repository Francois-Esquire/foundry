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

/** A package as the manifest lists it, by the fields the lens reads. */
interface RulesSourcePackage {
  id: string;
  path: string;
  status: "complete" | "failed";
}

/** One package report, by the fields the lens reads: its internalize opportunities and their plans. */
interface RulesSourceReport {
  id: string;
  opportunities: { id: string; place: string }[];
  plans: { blockers: string[]; id: string; status: PlanStatus }[];
}

/**
 * Every dataset field the lens reads: the places a subject can name, read
 * as the domains lens reads them for its facets, and the reports a
 * `require` needs.
 */
export interface RulesSource extends PlacesSource {
  /** Every package the manifest lists, failed ones included. */
  listed: RulesSourcePackage[];
  /** The report of each complete package a `require` subject meets. */
  reports: RulesSourceReport[];
}

const NOTHING_DECLARED: RulesSource = {
  files: [],
  listed: [],
  packages: [],
  reports: [],
  symbols: [],
};

/**
 * Whether a subject meets a package: the subject covers the package's root,
 * or lies inside it. A package at the workspace root holds every subject.
 * It chooses the reports to read and the failed packages a `require` could
 * not be checked in; whether the subject names a place is `kindOf`'s.
 */
function meets(subject: string, root: string): boolean {
  if (root === "" || root === WORKSPACE_ROOT) {
    return true;
  }
  const [path = subject] = subject.split("#");
  return covers(subject, root) || covers(root, path);
}

/** One package report, keeping only its internalize opportunities and plans. */
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

/** The violations of one `require` rule in one package report. */
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

/**
 * The workspace's rules against the dataset. A `require` of `internalize`
 * is a state: under its subject, no package-public symbol is unused
 * outside its package. Every `internalize-symbol` opportunity there is a
 * violation, carrying its saved plan's status and blocker reasons, so a
 * blocked one says why. A `permit` breaks nothing; it only lets a plan be
 * authorized. A rule never hides an observation: a subject that names no
 * place of the dataset, matched as the domains lens matches a facet, is
 * unmatched, and a package a `require` cannot be checked in is missing.
 */
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
  // With no rules, nothing is read. Otherwise the module index and the
  // package roots name the paths; a symbol subject's package report names
  // its symbols; and the reports a `require` meets are read one at a time.
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
