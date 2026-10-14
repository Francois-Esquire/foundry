import type { Rule } from "../rule-declaration";
import type { PlanStatus } from "../types";

/** Bumped when `Rules` changes shape or meaning. */
export const RULES_SCHEMA_VERSION = 1;

/** The saved plan for a violation's opportunity, by the fields that say whether it can be applied. */
interface RuleViolationPlan {
  /** The reasons of its blockers, sorted: `publishable` for a package published beyond the workspace. */
  blockers: string[];
  id: string;
  status: PlanStatus;
}

/**
 * One place where a `require` rule's outcome does not hold. For
 * `internalize`: a package-public symbol under the rule's subject that
 * nothing outside its package uses, as its package report's
 * `internalize-symbol` opportunity records it.
 */
export interface RuleViolation {
  /** The opportunity's id: `internalize-symbol:<path#name>`. */
  opportunity: string;
  /** The package it lives in, by manifest id. */
  package: string;
  /** The violating place, as a facet: `path#name`. */
  place: string;
  /** The saved plan for the opportunity; absent when the report holds none. */
  plan?: RuleViolationPlan;
  /** The broken rule, by its index in `rules`. */
  rule: number;
}

/** A `require` rule whose subject covers a package the scan could not analyze, so it was not checked there. */
export interface RuleMissing {
  /** The package, by manifest id. */
  package: string;
  rule: number;
}

/**
 * The `rules` lens. `rules` are the workspace's rules in canonical form and
 * in declaration order, neither sorted nor de-duplicated, since a rule is
 * named by its index; `unmatched` the indexes of rules whose subject names
 * no place in the dataset; `violations` sorted by rule, then place, then
 * package; `missing` sorted by rule, then package.
 */
export interface Rules {
  missing: RuleMissing[];
  rules: Rule[];
  unmatched: number[];
  violations: RuleViolation[];
}
