import { covers } from "./facet-cover";
import type { ArchitecturalOperator } from "./operator-types";
import type { Rule } from "./rule-declaration";
import { ruleCanName } from "./rule-declaration";
import { hash16 } from "./short-hash";

// What the workspace's rules say of a set of architectural operators: which
// rules permit each one, and which none permits. A rule permits an operator
// of its kind whose place its subject covers; a require permits too. Reads
// nothing but the rules and the operators.

/** One operator and the rules that permit it, by index. */
interface RulePermission {
  operatorId: string;
  /** The operator's place, as a facet. */
  place: string;
  rules: number[];
}

/** An operator a rule could name, which none permits. */
export interface RuleRefusal {
  operator: Rule["operator"];
  operatorId: string;
  /** The operator's place, as a facet; absent when it has none a subject can cover. */
  place?: string;
}

export interface RulePermits {
  permitted: RulePermission[];
  refused: RuleRefusal[];
}

/** The place a subject would have to cover: a symbol by its id, a concept or behavior by its concept's. */
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

/**
 * Which rules permit each operator. An operator of a kind no rule can name
 * yet is neither permitted nor refused here: no mutator executes it, which
 * the caller reports as the truer reason.
 */
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

/**
 * The rules in one canonical form, by index, with a fixed key order, so
 * that rules read from the configuration and rules read back from the
 * dataset compare and hash alike. Both paths must hand over the rules in
 * declaration order, neither sorted nor de-duplicated: the rules lens (3.3)
 * saves them so, since a rule is named by its index.
 */
export function canonicalRules(rules: readonly Rule[]): Rule[] {
  return rules.map(({ effect, operator, subject }) => ({
    effect,
    operator,
    subject,
  }));
}

/**
 * 16 hex digits of the SHA-256 of the canonical rules. A rule edited,
 * added, removed, or moved changes it, since a rule is named by its index.
 */
export function ruleFingerprint(rules: readonly Rule[]): string {
  return hash16(canonicalRules(rules));
}
