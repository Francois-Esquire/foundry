import { describe, expect, it } from "vitest";
import type { LensReader } from "../../src/lib/lenses/lens-types";
import type { RulesSource } from "../../src/lib/lenses/rules";
import { rulesLens } from "../../src/lib/lenses/rules";
import type { Rule } from "../../src/lib/rule-declaration";

const rule = (subject: string, effect: Rule["effect"] = "require"): Rule => ({
  effect,
  operator: "internalize",
  subject,
});

/** Core, with two unused exports, one in a publishable package's plan; checkout, failed; billing, clean. */
const SOURCE: RulesSource = {
  // A failed package's files are in no module index.
  files: [
    "packages/billing/src/invoice.ts",
    "packages/core/src/ids.ts",
    "packages/core/src/money.ts",
  ],
  listed: [
    { id: "@s/billing", path: "packages/billing", status: "complete" },
    { id: "@s/checkout", path: "apps/checkout", status: "failed" },
    { id: "@s/core", path: "packages/core", status: "complete" },
  ],
  packages: ["packages/billing", "packages/core"],
  reports: [
    { id: "@s/billing", opportunities: [], plans: [] },
    {
      id: "@s/core",
      opportunities: [
        {
          id: "internalize-symbol:packages/core/src/money.ts#round",
          place: "packages/core/src/money.ts#round",
        },
        {
          id: "internalize-symbol:packages/core/src/ids.ts#UserId",
          place: "packages/core/src/ids.ts#UserId",
        },
      ],
      plans: [
        {
          blockers: ["publishable"],
          id: "plan:internalize-symbol:packages/core/src/ids.ts#UserId",
          status: "blocked",
        },
        {
          blockers: [],
          id: "plan:internalize-symbol:packages/core/src/money.ts#round",
          status: "ready",
        },
      ],
    },
  ],
  symbols: [
    "packages/core/src/ids.ts#UserId",
    "packages/core/src/money.ts#round",
  ],
};

describe("the rules lens", () => {
  it("reports one violation per internalize opportunity under a require, with its plan's status and blocker reasons", () => {
    expect(
      rulesLens.derive(SOURCE, { rules: [rule("packages/core")] })
    ).toEqual({
      missing: [],
      rules: [rule("packages/core")],
      unmatched: [],
      violations: [
        {
          opportunity: "internalize-symbol:packages/core/src/ids.ts#UserId",
          package: "@s/core",
          place: "packages/core/src/ids.ts#UserId",
          plan: {
            blockers: ["publishable"],
            id: "plan:internalize-symbol:packages/core/src/ids.ts#UserId",
            status: "blocked",
          },
          rule: 0,
        },
        {
          opportunity: "internalize-symbol:packages/core/src/money.ts#round",
          package: "@s/core",
          place: "packages/core/src/money.ts#round",
          plan: {
            blockers: [],
            id: "plan:internalize-symbol:packages/core/src/money.ts#round",
            status: "ready",
          },
          rule: 0,
        },
      ],
    });
  });

  it("narrows a violation to the subject, by whole segments, and lets a permit break nothing", () => {
    const places = (rules: Rule[]) =>
      rulesLens
        .derive(SOURCE, { rules })
        .violations.map((v) => `${v.rule}:${v.place}`);
    expect(places([rule("packages/core/src/money.ts")])).toEqual([
      "0:packages/core/src/money.ts#round",
    ]);
    expect(places([rule("packages/core/src/ids.ts#UserId")])).toEqual([
      "0:packages/core/src/ids.ts#UserId",
    ]);
    expect(places([rule("packages/co")])).toEqual([]);
    expect(places([rule("packages/core", "permit")])).toEqual([]);
    // A wider subject meets every package below it.
    expect(places([rule("packages/billing"), rule("packages")])).toEqual([
      "1:packages/core/src/ids.ts#UserId",
      "1:packages/core/src/money.ts#round",
    ]);
  });

  it("keeps the rules in declaration order, and names a rule whose subject names no place and a require it could not check", () => {
    const rules = [
      rule("packages/next", "permit"),
      rule("apps"),
      rule("packages/billing"),
    ];
    expect(rulesLens.derive(SOURCE, { rules })).toEqual({
      missing: [{ package: "@s/checkout", rule: 1 }],
      rules,
      // apps names no place either: its only package failed.
      unmatched: [0, 1],
      violations: [],
    });
  });

  it("matches a subject to a place as the domains lens matches a facet, so a mistyped symbol or a missing file is unmatched", () => {
    const rules = [
      rule("packages/core/src/ids.ts#UserID"),
      rule("packages/core/src/gone.ts"),
      rule("packages/core/src", "permit"),
      rule("packages/core/src/ids.ts"),
      rule("packages/core/src/ids.ts#UserId", "permit"),
      rule("packages/core"),
    ];
    const lens = rulesLens.derive(SOURCE, { rules });
    expect(lens.unmatched).toEqual([0, 1]);
    // An unmatched subject still finds nothing to break.
    expect(lens.violations.map((v) => `${v.rule}:${v.place}`)).toEqual([
      "3:packages/core/src/ids.ts#UserId",
      "5:packages/core/src/ids.ts#UserId",
      "5:packages/core/src/money.ts#round",
    ]);
  });

  it("holds every subject inside a package at the workspace root, which names no place itself", () => {
    const source: RulesSource = {
      files: ["packages/core/src/a.ts", "src/a.ts"],
      listed: [{ id: "root", path: "", status: "complete" }],
      packages: [],
      reports: [
        {
          id: "root",
          opportunities: [
            { id: "internalize-symbol:src/a.ts#a", place: "src/a.ts#a" },
          ],
          plans: [],
        },
      ],
      symbols: [],
    };
    const lens = rulesLens.derive(source, {
      rules: [rule("src"), rule("pakages/core"), rule("packages/core")],
    });
    expect(lens.unmatched).toEqual([1]);
    expect(lens.violations).toEqual([
      {
        opportunity: "internalize-symbol:src/a.ts#a",
        package: "root",
        place: "src/a.ts#a",
        rule: 0,
      },
    ]);
  });

  it("reads nothing with no rules; with rules, the module index, the reports a require meets, and a symbol subject's package's symbols, one report at a time", async () => {
    const read: string[] = [];
    let reading = 0;
    let mostAtOnce = 0;
    const reader = {
      moduleIndex: async () => ({
        modules: [{ id: "p/a/a.ts", package: "p/a", shard: "large" }],
      }),
      packageReport: async (id: string) => {
        read.push(id);
        reading += 1;
        mostAtOnce = Math.max(mostAtOnce, reading);
        await new Promise((resolve) => setTimeout(resolve, 1));
        reading -= 1;
        return {
          opportunities: [
            {
              id: "fold-package:x",
              operation: "fold-package",
              subject: { id: "x" },
            },
            {
              id: `internalize-symbol:${id}/a.ts#a`,
              operation: "internalize-symbol",
              subject: { id: `${id}/a.ts#a` },
            },
          ],
          plans: [
            {
              blockers: [
                { detail: "one", reason: "publishable" },
                { detail: "two", reason: "publishable" },
              ],
              id: `plan:internalize-symbol:${id}/a.ts#a`,
              operation: "internalize-symbol",
              status: "blocked",
            },
            { blockers: [], id: "plan:fold", operation: "fold-package" },
          ],
          symbols: [{ id: `${id}/x.ts#x`, name: "x", references: ["large"] }],
        };
      },
      packages: () => [
        { id: "p/a", internals: true, path: "p/a", status: "complete" },
        { id: "p/b", internals: true, path: "p/b", status: "complete" },
        { id: "p/c", internals: false, path: "p/c", status: "failed" },
      ],
    } as unknown as LensReader;
    expect(await rulesLens.read(reader, { rules: [] })).toEqual({
      files: [],
      listed: [],
      packages: [],
      reports: [],
      symbols: [],
    });
    expect(read).toEqual([]);
    const source = await rulesLens.read(reader, {
      rules: [rule("p/a"), rule("p/b/x.ts#x", "permit"), rule("p/c")],
    });
    expect(read).toEqual(["p/a", "p/b"]);
    expect(mostAtOnce).toBe(1);
    expect(source).toEqual({
      files: ["p/a/a.ts"],
      listed: [
        { id: "p/a", path: "p/a", status: "complete" },
        { id: "p/b", path: "p/b", status: "complete" },
        { id: "p/c", path: "p/c", status: "failed" },
      ],
      packages: ["p/a", "p/b"],
      reports: [
        {
          id: "p/a",
          opportunities: [
            { id: "internalize-symbol:p/a/a.ts#a", place: "p/a/a.ts#a" },
          ],
          plans: [
            {
              blockers: ["publishable"],
              id: "plan:internalize-symbol:p/a/a.ts#a",
              status: "blocked",
            },
          ],
        },
      ],
      symbols: ["p/b/x.ts#x"],
    });
  });
});
