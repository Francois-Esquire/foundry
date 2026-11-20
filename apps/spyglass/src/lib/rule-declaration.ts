import { z } from "zod";
import { facetSchema } from "./facet";
import type { ArchitecturalOperatorKind } from "./operator-types";

const RULE_OPERATORS = [
  "internalize",
] as const satisfies readonly ArchitecturalOperatorKind[];

const RULE_EFFECTS = ["permit", "require"] as const;

export interface Rule {
  effect: (typeof RULE_EFFECTS)[number];
  operator: (typeof RULE_OPERATORS)[number];
  subject: string;
}

export function ruleCanName(
  kind: ArchitecturalOperatorKind
): kind is Rule["operator"] {
  return RULE_OPERATORS.some((operator) => operator === kind);
}

function choices(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value}"`);
  if (quoted.length <= 2) {
    return quoted.join(" or ");
  }
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

const OPERATOR_RULE = `must be ${choices(RULE_OPERATORS)}, ${
  RULE_OPERATORS.length === 1
    ? "the one operator rules can name so far"
    : "the operators rules can name so far"
}`;
const EFFECT_RULE = `must be ${choices(RULE_EFFECTS)}`;

const ruleSchema = z.strictObject(
  {
    effect: z.enum(RULE_EFFECTS, { error: EFFECT_RULE }),
    operator: z.enum(RULE_OPERATORS, { error: OPERATOR_RULE }),
    subject: facetSchema,
  },
  { error: "must be an object" }
);

function checkRepeats(rules: readonly Rule[], context: z.RefinementCtx): void {
  const first = new Map<string, { effect: Rule["effect"]; index: number }>();
  for (const [index, rule] of rules.entries()) {
    const key = `${rule.operator}\n${rule.subject}`;
    const earlier = first.get(key);
    if (earlier === undefined) {
      first.set(key, { effect: rule.effect, index });
      continue;
    }
    context.addIssue({
      code: "custom",
      input: rule,
      message:
        earlier.effect === rule.effect
          ? `repeats rules[${earlier.index}]`
          : `names the operator and subject of rules[${earlier.index}] again, and a require permits too, so keep only the require`,
      params: { wholeObject: true },
      path: [index],
    });
  }
}

export const rulesSchema = z
  .array(ruleSchema, { error: "must be a list of rules" })
  .superRefine(checkRepeats);
