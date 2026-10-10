import { expect, it } from "vitest";
import type { Rule } from "../../src/lib/rule-declaration";
import { canonicalRules, permits, ruleFingerprint } from "../../src/lib/rules";
import { internalizeOperator } from "./helpers/planning-fixture";

const FINGERPRINT = /^[0-9a-f]{16}$/;
const SYMBOL = "packages/core/src/helper.ts#helperOnly";
const operator = internalizeOperator(SYMBOL, "@p/core");
const rule = (subject: string, effect: Rule["effect"] = "permit"): Rule => ({
  effect,
  operator: "internalize",
  subject,
});

it("permits an operator whose place a rule of its kind covers, require included", () => {
  expect(
    permits(
      [rule("packages/lib"), rule("packages/core", "require"), rule(SYMBOL)],
      [operator]
    )
  ).toEqual({
    permitted: [{ operatorId: operator.id, place: SYMBOL, rules: [1, 2] }],
    refused: [],
  });
});

it("refuses an operator no rule covers, by whole segments", () => {
  expect(permits([rule("packages/co")], [operator])).toEqual({
    permitted: [],
    refused: [
      { operator: "internalize", operatorId: operator.id, place: SYMBOL },
    ],
  });
});

it("leaves an operator of a kind no rule can name to the caller", () => {
  const moved = { ...operator, id: "operator:move:x", kind: "move" as const };
  expect(permits([], [moved])).toEqual({ permitted: [], refused: [] });
});

it("hashes one canonical form, whatever the key order or extra fields", () => {
  const written = [rule("packages/core")];
  const readBack = [
    {
      effect: "permit",
      extra: true,
      operator: "internalize",
      subject: "packages/core",
    } as Rule,
  ];
  expect(canonicalRules(readBack)).toEqual(written);
  expect(JSON.stringify(canonicalRules(readBack))).toBe(
    '[{"effect":"permit","operator":"internalize","subject":"packages/core"}]'
  );
  expect(ruleFingerprint(readBack)).toBe(ruleFingerprint(written));
});

it("changes the fingerprint when a rule moves, since a rule is named by its index", () => {
  const rules = [rule("packages/core"), rule("packages/lib")];
  expect(ruleFingerprint([...rules].reverse())).not.toBe(
    ruleFingerprint(rules)
  );
  expect(ruleFingerprint([])).toMatch(FINGERPRINT);
});
