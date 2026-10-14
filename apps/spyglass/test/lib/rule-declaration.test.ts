import { expect, it } from "vitest";
import { parseConfigFile } from "../../src/lib/spyglass-config";

// Rules are validated as part of a configuration file's default export, so
// these tests go through the same parse the loader runs on each file. Their
// subjects share the facet rules the domain tests cover one by one.

const FILE = ".foundry/spyglass/rules.ts";

function rules(value: unknown): unknown {
  return parseConfigFile({ rules: value }, FILE).rules;
}

function rejection(value: unknown): string {
  try {
    rules(value);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the rules were accepted");
}

it("accepts permit and require rules over paths and symbols, as written", () => {
  const declared = [
    { effect: "require", operator: "internalize", subject: "packages/core" },
    {
      effect: "permit",
      operator: "internalize",
      subject: "packages/lib/src/ids.ts#InvoiceId",
    },
    // A subject need not exist yet.
    { effect: "permit", operator: "internalize", subject: "packages/next" },
  ];
  expect(rules(declared)).toEqual(declared);
});

it("accepts an empty list of rules", () => {
  expect(rules([])).toEqual([]);
});

it("accepts a narrower subject inside a wider one", () => {
  const declared = [
    { effect: "require", operator: "internalize", subject: "packages/core" },
    {
      effect: "permit",
      operator: "internalize",
      subject: "packages/core/src/ids.ts",
    },
  ];
  expect(rules(declared)).toEqual(declared);
});

it.each([
  [
    "move",
    'rules[0].operator must be "internalize", the one operator rules can name so far; got "move".',
  ],
  [
    "internalize-export",
    'rules[0].operator must be "internalize", the one operator rules can name so far; got "internalize-export".',
  ],
  [
    undefined,
    'rules[0].operator must be "internalize", the one operator rules can name so far; got nothing.',
  ],
])("rejects the operator %j", (operator, issue) => {
  expect(
    rejection([{ effect: "permit", operator, subject: "packages/core" }])
  ).toBe(`Configuration ${FILE}: ${issue}`);
});

it.each([
  ["forbid", 'rules[0].effect must be "permit" or "require"; got "forbid".'],
  [true, 'rules[0].effect must be "permit" or "require"; got true.'],
])("rejects the effect %j", (effect, issue) => {
  expect(
    rejection([{ effect, operator: "internalize", subject: "packages/core" }])
  ).toBe(`Configuration ${FILE}: ${issue}`);
});

it.each([
  ["", 'rules[0].subject must be a workspace-relative path; got "".'],
  [
    "packages/core/",
    'rules[0].subject must have no empty, ".", or ".." segments, and no trailing "/"; got "packages/core/".',
  ],
  [
    "packages/*",
    'rules[0].subject must not use "*", "?", or a leading "!", which are reserved for patterns; got "packages/*".',
  ],
  [
    ".",
    'rules[0].subject must have no empty, ".", or ".." segments, and no trailing "/"; got ".".',
  ],
  [7, "rules[0].subject must be a workspace-relative path; got 7."],
])("rejects the subject %j as a facet", (subject, issue) => {
  expect(
    rejection([{ effect: "permit", operator: "internalize", subject }])
  ).toBe(`Configuration ${FILE}: ${issue}`);
});

it("rejects a rule that is not an object, a list that is not one, and unknown keys", () => {
  expect(rejection(["packages/core"])).toBe(
    `Configuration ${FILE}: rules[0] must be an object; got "packages/core".`
  );
  expect(rejection({ effect: "permit" })).toBe(
    `Configuration ${FILE}: rules must be a list of rules; got an object.`
  );
  expect(
    rejection([
      {
        effect: "permit",
        operator: "internalize",
        reason: "Unused exports go.",
        subject: "packages/core",
      },
    ])
  ).toBe(`Configuration ${FILE}: rules[0] has unknown key reason.`);
});

it("names every invalid rule by its index", () => {
  expect(
    rejection([
      { effect: "permit", operator: "internalize", subject: "packages/ok" },
      { effect: "permit", operator: "move", subject: "/abs" },
    ])
  ).toBe(
    `Configuration ${FILE}: rules[1].operator must be "internalize", the one operator rules can name so far; got "move"; rules[1].subject must be relative to the workspace root; got "/abs".`
  );
});

it("rejects a rule repeated with the same effect", () => {
  const rule = {
    effect: "require",
    operator: "internalize",
    subject: "packages/core",
  };
  expect(rejection([rule, { ...rule }])).toBe(
    `Configuration ${FILE}: rules[1] repeats rules[0].`
  );
});

it("rejects a permit beside a require of the same subject, since a require permits too", () => {
  const permit = {
    effect: "permit",
    operator: "internalize",
    subject: "packages/core",
  };
  const message = (earlier: number, later: number) =>
    `Configuration ${FILE}: rules[${later}] names the operator and subject of rules[${earlier}] again, and a require permits too, so keep only the require.`;
  expect(rejection([permit, { ...permit, effect: "require" }])).toBe(
    message(0, 1)
  );
  expect(rejection([{ ...permit, effect: "require" }, permit])).toBe(
    message(0, 1)
  );
});
