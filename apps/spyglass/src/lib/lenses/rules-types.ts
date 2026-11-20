import type { Rule } from "../rule-declaration";
import type { PlanStatus } from "../types";

export const RULES_SCHEMA_VERSION = 1;

interface RuleViolationPlan {
  blockers: string[];
  id: string;
  status: PlanStatus;
}

export interface RuleViolation {
  opportunity: string;
  package: string;
  place: string;
  plan?: RuleViolationPlan;
  rule: number;
}

export interface RuleMissing {
  package: string;
  rule: number;
}

export interface Rules {
  missing: RuleMissing[];
  rules: Rule[];
  unmatched: number[];
  violations: RuleViolation[];
}
