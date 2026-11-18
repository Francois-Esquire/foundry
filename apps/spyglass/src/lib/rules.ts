import { covers } from "./facet-cover";
import type { ArchitecturalOperator } from "./operator-types";
import type { Rule } from "./rule-declaration";
import { ruleCanName } from "./rule-declaration";
import { hash16 } from "./short-hash";

interface RulePermission {
  operatorId: string;
  place: string;
  rules: number[];
}

export interface RuleRefusal {
  operator: Rule["operator"];
  operatorId: string;
  place?: string;
}

export interface RulePermits {
  permitted: RulePermission[];
  refused: RuleRefusal[];
}

function placeOf(operator: ArchitecturalOperator): string | undefined {
  const { subject } = operator;
  switch (subject.kind) {
    case "symbol":
      return subject.symbolId;
    case "concept":
    case "behavior":
      return subject.conceptId;
    default:
      return undefined;
  }
}

export function permits(
  rules: readonly Rule[],
  operators: readonly ArchitecturalOperator[]
): RulePermits {
  const permitted: RulePermission[] = [];
  const refused: RuleRefusal[] = [];
  for (const operator of operators) {
    const { kind } = operator;
    if (!ruleCanName(kind)) {
      continue;
    }
    const place = placeOf(operator);
    const indexes = rules.flatMap((rule, index) =>
      rule.operator === kind &&
      place !== undefined &&
      covers(rule.subject, place)
        ? [index]
        : []
    );
    if (place === undefined || indexes.length === 0) {
      refused.push({
        operator: kind,
        operatorId: operator.id,
        ...(place !== undefined && { place }),
      });
    } else {
      permitted.push({ operatorId: operator.id, place, rules: indexes });
    }
  }
  return { permitted, refused };
}

export function canonicalRules(rules: readonly Rule[]): Rule[] {
  return rules.map(({ effect, operator, subject }) => ({
    effect,
    operator,
    subject,
  }));
}

export function ruleFingerprint(rules: readonly Rule[]): string {
  return hash16(canonicalRules(rules));
}
