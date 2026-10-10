import { z } from "zod";
import { facetSchema } from "./facet";
import type { ArchitecturalOperatorKind } from "./operator-types";

// The rule declaration: what a workspace says must, or may, be true of its
// own structure. A configuration file declares rules under `rules`. They are
// kept as written, read by no analysis, and left out of the configuration
// fingerprint, so a scan with new rules reuses every package's results. A
// rule is named by its index, `rules[0]`, so reordering the list renames
// every rule. See docs/atlas/_codemods.md.

/** The operators a rule can name: catalog kinds, widened one at a time as each becomes executable. */
const RULE_OPERATORS = [
  "internalize",
] as const satisfies readonly ArchitecturalOperatorKind[];

/** What a rule says of its operator: it may be applied, or its outcome must hold. */
const RULE_EFFECTS = ["permit", "require"] as const;

/** One rule, as a configuration file declares it under `rules`. */
export interface Rule {
  /**
   * `permit`: a plan for the operator on a place under the subject may be
   * authorized. `require`: under the subject, the operator's outcome must
   * hold, and `atlas check` reports every place where it does not. A require
   * permits too.
   */
  effect: (typeof RULE_EFFECTS)[number];
  /** An operator-catalog kind; `internalize` is the only one so far. */
  operator: (typeof RULE_OPERATORS)[number];
  /** The place the rule names, written as a facet: a workspace-relative path, or `path#name`. It need not exist. */
  subject: string;
}

/** Whether a rule can name this operator kind yet. */
export function ruleCanName(
  kind: ArchitecturalOperatorKind
): kind is Rule["operator"] {
  return RULE_OPERATORS.some((operator) => operator === kind);
}

/** Quoted choices as a message lists them: `"a"`, `"a" or "b"`, `"a", "b", or "c"`. */
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

/**
 * Across the list: one rule per operator and subject. A second with the same
 * effect repeats the first; a permit beside a require says nothing the
 * require does not, since a require permits too.
 */
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

/** The `rules` setting of a configuration file. */
export const rulesSchema = z
  .array(ruleSchema, { error: "must be a list of rules" })
  .superRefine(checkRepeats);
