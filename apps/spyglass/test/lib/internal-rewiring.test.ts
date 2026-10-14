import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { runInternalAnalysis } from "../../src/lib/internal-analysis";
import { analyzeInternalResponsibilities } from "../../src/lib/internal-responsibility";
import {
  analyzeInternalRewiring,
  getCompositionEvidence,
  getRewiringScenario,
  getScenariosByKind,
  getScenariosForModule,
  getScenariosForResponsibility,
  getScenariosForSymbol,
} from "../../src/lib/internal-rewiring";
import type {
  InternalRewiringReport,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
} from "../../src/lib/internal-rewiring-types";
import { INTERNAL_REWIRING_SCHEMA_VERSION } from "../../src/lib/internal-rewiring-types";
import { analyzeInternalPackageTopology } from "../../src/lib/internal-topology";
import { analyzePackageLocal } from "../../src/lib/package-local";
import { analyzePrimitiveConventions } from "../../src/lib/primitive-convention";
import { renderInternalRewiring } from "../../src/lib/report-rewiring";
import { analyzeSymbolLocality } from "../../src/lib/symbol-locality";

const expectedTextPattern =
  /no contract, adapter, or implementation role \(CoreAdapter: implementation\)/;
const expectedTextPattern2 = /already reaches the target scope/;
const expectedTextPattern3 = /ordinary dependency/;
const expectedTextPattern4 = /construction, registration/;
const expectedTextPattern5 = /^partial: separate 1 of 3/;
const expectedTextPattern6 = /:responsibility:.*$/;
const expectedTextPattern7 = /^follows colocate-primitive:/;
const expectedTextPattern8 = /"exactPath":"(?!deferred")/;
const specifierPattern = /\.tsx?$/;

// V13.4 rewiring scenarios on synthetic packages. Each fixture is one
// package in a throwaway workspace. The high-fan cutoff floors at 3, so a
// root module with dependents in three directories is a connector and
// stays unresolved; the package-wide floor is 3 responsibilities; and a
// seed consumed by fewer than 3 modules joins its endpoints' regions, so
// cross-region fixtures carry constants and functions, or seeds consumed
// by 3+ modules.

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function workspace(
  files: Record<string, string>,
  extra: Record<string, string> = {}
): string {
  const dir = mkdtempSync(join(tmpdir(), "rewiring-"));
  const root = realpathSync(dir);
  tempRoots.push(root);
  const write = (file: string, text: string) => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  write(
    "package.json",
    JSON.stringify({ name: "root", workspaces: ["packages/*"] })
  );
  write(
    "packages/p/package.json",
    JSON.stringify({ exports: { ".": "./src/index.ts" }, name: "@f/p" })
  );
  for (const [file, text] of Object.entries(files)) {
    write(join("packages/p", file), text);
  }
  for (const [file, text] of Object.entries(extra)) {
    write(file, text);
  }
  return root;
}

function derive(root: string): InternalRewiringReport {
  const local = analyzePackageLocal({ root, target: "packages/p" });
  const topology = analyzeInternalPackageTopology(local);
  const locality = analyzeSymbolLocality(local, topology);
  const responsibilities = analyzeInternalResponsibilities(
    local,
    topology,
    locality
  );
  const primitives = analyzePrimitiveConventions(
    local,
    topology,
    locality,
    responsibilities
  );
  return analyzeInternalRewiring(
    local,
    topology,
    locality,
    responsibilities,
    primitives
  );
}

function rewiringOf(
  files: Record<string, string>,
  extra?: Record<string, string>
): InternalRewiringReport {
  return derive(workspace(files, extra));
}

function importOf(from: string, to: string, names: string): string {
  let specifier = posix.relative(
    posix.dirname(from),
    to.replace(specifierPattern, "")
  );
  if (!specifier.startsWith(".")) {
    specifier = `./${specifier}`;
  }
  return `import { ${names} } from "${specifier}";\n`;
}

const id = (module: string, name: string) => `packages/p/${module}#${name}`;

function kindsFor(
  report: InternalRewiringReport,
  key: string
): InternalRewiringScenarioKind[] {
  const family = report.families.find((f) => f.subject.key === key);
  if (family === undefined) {
    throw new Error(`no family: ${key}`);
  }
  return family.scenarioIds.map((scenarioId) => {
    const rewiringScenario = getRewiringScenario(report, scenarioId);
    if (rewiringScenario === undefined) {
      throw new Error(`no scenario: ${scenarioId}`);
    }
    return rewiringScenario.kind;
  });
}

function scenario(
  report: InternalRewiringReport,
  key: string,
  kind: InternalRewiringScenarioKind
): InternalRewiringScenario {
  const found = report.scenarios.find(
    (s) => s.subject.key === key && s.kind === kind
  );
  if (found === undefined) {
    throw new Error(`no scenario: ${key} ${kind}`);
  }
  return found;
}

function responsibilityOf(report: InternalRewiringReport, module: string) {
  const entry = report.composition.find((c) => c.module === module);
  return entry?.responsibility;
}

/**
 * Three directory regions a, b, c; a root hub with a localized symbol into
 * each (unresolved distributed primitive); a wide-dependent app module
 * without wiring (unresolved, unclear). `LOCAL_B` sits in a and serves b.
 */
function hubFixture(): Record<string, string> {
  return {
    "src/a/a1.ts":
      importOf(
        "src/a/a1.ts",
        "src/shared.ts",
        "LocalToA, AAlias, AHidden, Wide, wideUtil, CROSS_LIMIT, Partial"
      ) +
      importOf("src/a/a1.ts", "src/a/a2.ts", "A2") +
      "export type A1 = [LocalToA, AAlias, AHidden, Wide, A2, Partial];\n" +
      "export const a1 = wideUtil(CROSS_LIMIT);\n",
    "src/a/a2.ts":
      "export interface A2 { a: string }\nexport const LOCAL_B = 1;\n",
    "src/app.ts":
      importOf("src/app.ts", "src/a/a1.ts", "A1") +
      importOf("src/app.ts", "src/b/b1.ts", "B1") +
      importOf("src/app.ts", "src/c/c1.ts", "C1") +
      importOf("src/app.ts", "src/shared.ts", "OnlyApp, Partial") +
      "export type App = [A1, B1, C1, OnlyApp, Partial];\n",
    "src/b/b1.ts":
      importOf(
        "src/b/b1.ts",
        "src/shared.ts",
        "LocalToB, Wide, wideUtil, CROSS_LIMIT"
      ) +
      importOf("src/b/b1.ts", "src/a/a2.ts", "LOCAL_B") +
      importOf("src/b/b1.ts", "src/b/b2.ts", "B2") +
      "export type B1 = [LocalToB, Wide, B2];\n" +
      "export const b1 = wideUtil(LOCAL_B + CROSS_LIMIT);\n",
    "src/b/b2.ts": "export interface B2 { b: string }\n",
    "src/c/c1.ts":
      importOf("src/c/c1.ts", "src/shared.ts", "LocalToC, Wide, wideUtil") +
      importOf("src/c/c1.ts", "src/c/c2.ts", "C2") +
      "export type C1 = [LocalToC, Wide, C2];\nexport const c1 = wideUtil(1);\n",
    "src/c/c2.ts": "export interface C2 { c: string }\n",
    "src/index.ts": 'export * from "./a/a1";\nexport * from "./a/a2";\n',
    "src/shared.ts":
      "export interface LocalToA { a: string }\n" +
      "export interface LocalToB { b: string }\n" +
      "export interface LocalToC { c: string }\n" +
      "export const CROSS_LIMIT = 3;\n" +
      "export interface Wide { w: string }\n" +
      "export function wideUtil(n: number): number { return n + 1; }\n" +
      "export type AAlias = LocalToA[];\n" +
      "interface Hidden { h: string }\n" +
      "export type AHidden = Hidden & { x: 1 };\n" +
      "export interface OnlyApp { o: string }\n" +
      "export interface Partial { p: string }\n",
  };
}

describe("hub", () => {
  const report = rewiringOf(hubFixture());
  const regionA = responsibilityOf(report, "src/a/a1.ts") ?? "";
  const regionB = responsibilityOf(report, "src/b/b1.ts") ?? "";
  const hubA = `src/shared.ts|${regionA}`;

  it("versions the report and keeps every scenario counterfactual", () => {
    expect(report.schemaVersion).toBe(INTERNAL_REWIRING_SCHEMA_VERSION);
    expect(report.policy.ranking).toBe("none");
    expect(report.policy.targets).toContain("exact paths deferred");
    expect(JSON.stringify(report)).not.toMatch(expectedTextPattern8);
    expect(regionA).not.toBe("");
    expect(regionB).not.toBe("");
  });

  it("colocates a responsibility-local group out of the unresolved hub, baseline first", () => {
    expect(kindsFor(report, hubA)).toEqual([
      "preserve-current",
      "colocate-primitive",
    ]);
    const colocate = scenario(report, hubA, "colocate-primitive");
    expect(colocate.subject.symbolIds).toEqual([
      id("src/shared.ts", "AAlias"),
      id("src/shared.ts", "AHidden"),
      id("src/shared.ts", "LocalToA"),
      id("src/shared.ts", "Partial"),
    ]);
    expect(colocate.proposed).toMatchObject({
      candidateModules: [],
      responsibility: regionA,
      scope: "responsibility-local",
    });
    expect(colocate.rationale.sources).toEqual([
      "declared-in-unresolved-module",
    ]);
    expect(colocate.effects.locality).toEqual({
      after: "declared-in-serving-responsibility",
      before: "declared-in-unresolved-module",
      symbols: 4,
    });
    // a1 and app keep importing other symbols from the hub, so both edges
    // are retargeted rather than removed, and each consumer gains an edge.
    expect(colocate.effects.responsibilityBoundaries).toMatchObject({
      crossingSymbols: { after: 0, before: 4 },
      unresolvedEdges: { after: 3, before: 2 },
      withinEdges: { after: 1, before: 0 },
    });
    expect(colocate.effects.dependencies).toMatchObject({
      edgesAdded: 2,
      edgesRemoved: 0,
      edgesRetargeted: 2,
    });
    expect(colocate.effects.moduleComposition.modules).toEqual({
      after: 10,
      before: 9,
    });
    expect(colocate.effects.moduleComposition.scopeGroups).toEqual({
      after: 4,
      before: 5,
    });
  });

  it("records the movement closure from declaration facts", () => {
    const colocate = scenario(report, hubA, "colocate-primitive");
    expect(colocate.closure).toMatchObject({
      blockers: [],
      optional: [],
      required: [
        {
          relationships: ["type-reference"],
          symbolId: id("src/shared.ts", "Hidden"),
        },
      ],
      size: "small",
    });
  });

  it("keeps unresolved consumers and the missing target as explicit uncertainty", () => {
    const colocate = scenario(report, hubA, "colocate-primitive");
    const reasons = colocate.uncertainties.map((u) => u.reason);
    expect(reasons).toContain("unresolved-consumers");
    expect(reasons).toContain("target-module-unresolved");
    expect(reasons).toContain("internal-anchors-unavailable");
    expect(reasons).not.toContain("package-public-external-impact");
    expect(colocate.current.unresolvedConsumers).toBe(1);
  });

  it("follows the placement with a dependency redirect over the carrying edges", () => {
    const key = `${regionA}→src/shared.ts`;
    expect(kindsFor(report, key)).toEqual([
      "preserve-current",
      "redirect-internal-dependency",
    ]);
    const redirect = scenario(report, key, "redirect-internal-dependency");
    expect(redirect.subject.kind).toBe("internal-dependency");
    expect(redirect.subject.edges).toEqual([
      { source: "src/a/a1.ts", target: "src/shared.ts" },
      { source: "src/app.ts", target: "src/shared.ts" },
    ]);
    expect(redirect.proposed.redirect?.[0]?.symbolIds).toHaveLength(4);
    expect(redirect.proposed.redirect?.[1]?.symbolIds).toEqual([
      id("src/shared.ts", "Partial"),
    ]);
    expect(redirect.effects.dependencies.edgesRetargeted).toBe(2);
    expect(redirect.rationale.facts[0]).toMatch(expectedTextPattern7);
  });

  it("demotes a symbol declared in another placed responsibility and flags its public exposure", () => {
    const key = `src/a/a2.ts|${regionB}`;
    expect(kindsFor(report, key)).toEqual([
      "preserve-current",
      "demote-primitive",
    ]);
    const demote = scenario(report, key, "demote-primitive");
    expect(demote.subject.symbolIds).toEqual([id("src/a/a2.ts", "LOCAL_B")]);
    expect(demote.current).toMatchObject({
      locality: "declared-outside-serving-responsibility",
      responsibility: regionA,
    });
    expect(demote.proposed.responsibility).toBe(regionB);
    expect(demote.effects.responsibilityBoundaries.crossEdges).toEqual({
      after: 0,
      before: 1,
    });
    expect(demote.effects.dependencies.modules[0]?.fanIn).toEqual({
      after: 2,
      before: 3,
    });
    expect(demote.closure?.size).toBe("independent");
    expect(demote.preservations).toContain("public-exposure");
    expect(demote.uncertainties.map((u) => u.reason)).toContain(
      "package-public-external-impact"
    );
  });

  it("preserves package-wide primitives instead of moving them", () => {
    const key = "src/shared.ts|package-wide";
    expect(kindsFor(report, key)).toEqual([
      "preserve-current",
      "preserve-package-primitive",
    ]);
    const preserve = scenario(report, key, "preserve-package-primitive");
    expect(preserve.subject.symbolIds).toEqual([
      id("src/shared.ts", "Wide"),
      id("src/shared.ts", "wideUtil"),
    ]);
    expect(preserve.preservations).toContain("package-wide-scope");
    expect(preserve.effects.dependencies.edgesRemoved).toBe(0);
    expect(
      getScenariosByKind(report, "demote-primitive").some((s) =>
        s.subject.symbolIds?.includes(id("src/shared.ts", "wideUtil"))
      )
    ).toBe(false);
    expect(
      report.families.find((f) => f.subject.key === key)?.preservationOnly
    ).toBe(true);
  });

  it("preserves a cross-responsibility constant held by the hub", () => {
    const key = "src/shared.ts|cross-responsibility";
    expect(kindsFor(report, key)).toEqual([
      "preserve-current",
      "preserve-cross-responsibility-contract",
    ]);
    const preserve = scenario(
      report,
      key,
      "preserve-cross-responsibility-contract"
    );
    expect(preserve.subject.symbolIds).toEqual([
      id("src/shared.ts", "CROSS_LIMIT"),
    ]);
    expect(preserve.preservations).toContain("cross-responsibility-contract");
  });

  it("splits the mixed-scope hub partially, keeping broad and unplaced groups", () => {
    const kinds = kindsFor(report, "src/shared.ts");
    expect(kinds).toEqual([
      "preserve-current",
      "split-module-by-responsibility",
    ]);
    const split = scenario(
      report,
      "src/shared.ts",
      "split-module-by-responsibility"
    );
    expect(
      split.proposed.separated?.map((g) => ("key" in g ? g.key : g.role))
    ).toEqual([`responsibility-local:${regionA}`]);
    expect(
      split.proposed.remainder?.map(
        (g) =>
          `${g.key.replace(expectedTextPattern6, "")} ${g.symbolIds.length}`
      )
    ).toEqual([
      "package-wide 2",
      "cross-responsibility 1",
      "responsibility-local 1",
      "responsibility-local 1",
      "unplaced 1",
    ]);
    expect(split.preservations).toEqual(
      expect.arrayContaining([
        "package-wide-scope",
        "cross-responsibility-contract",
      ])
    );
    expect(split.rationale.facts[1]).toMatch(expectedTextPattern5);
    const candidate = report.candidates.find(
      (c) =>
        c.subject.key === "src/shared.ts" &&
        c.kind === "split-module-by-responsibility"
    );
    expect(candidate?.eligibility.eligible).toBe(true);
  });

  it("leaves a wide-dependent module without wiring as unclear, not a root", () => {
    const app = getCompositionEvidence(report, "src/app.ts");
    expect(app?.roles).toEqual(["unclear"]);
    expect(app?.compositionRoot).toBe(false);
    expect(app?.responsibilities).toHaveLength(3);
    const candidate = report.candidates.find(
      (c) =>
        c.subject.key === "src/app.ts" && c.kind === "preserve-composition-root"
    );
    expect(candidate?.eligibility.eligible).toBe(false);
    expect(candidate?.eligibility.missingEvidence[0]).toMatch(
      expectedTextPattern4
    );
    expect(report.summary.composition.wideDependents).toEqual({
      roots: 0,
      total: 1,
      unclear: 1,
    });
    expect(report.families.some((f) => f.subject.key === "src/app.ts")).toBe(
      false
    );
  });

  it("gives no scenario to an unplaced or unclear symbol", () => {
    expect(
      getScenariosForSymbol(report, id("src/shared.ts", "OnlyApp")).filter(
        (s) => s.subject.kind === "symbol-group"
      )
    ).toEqual([]);
    expect(
      getScenariosForSymbol(report, id("src/a/a1.ts", "A1")).filter(
        (s) => s.subject.kind === "symbol-group"
      )
    ).toEqual([]);
  });

  it("summarizes candidates against scenarios", () => {
    expect(report.summary.candidates.total).toBeGreaterThan(
      report.summary.candidates.eligible
    );
    expect(report.summary.families.insufficientEvidence).toBeGreaterThanOrEqual(
      1
    );
    expect(report.summary.byKind["preserve-current"]).toBe(
      report.summary.families.total
    );
    // 7 symbol groups, 4 redirects, and A2: the one type beside a constant
    // against an 8:1 dedicated-module convention.
    expect(report.summary.families.total).toBe(12);
    expect(
      kindsFor(report, "src/a/a2.ts|align:type/responsibility-local")
    ).toEqual(["preserve-current", "align-with-convention"]);
    expect(report.summary.effects.localDeclarationsMoved).toBe(7);
    expect(report.summary.effects.packageWidePreserved).toBe(2);
  });

  it("answers the query helpers", () => {
    expect(
      getScenariosForModule(report, "src/shared.ts").length
    ).toBeGreaterThan(4);
    expect(
      getScenariosForResponsibility(report, regionB).some(
        (s) => s.kind === "demote-primitive"
      )
    ).toBe(true);
    expect(getRewiringScenario(report, "nope")).toBeUndefined();
  });

  it("renders the summary and the scenario sections", () => {
    const text = renderInternalRewiring(report);
    expect(text).toContain("INTERNAL REWIRING SCENARIOS");
    expect(text).toContain("PRIMITIVE LOCALITY");
    expect(text).toContain("COLOCATE PRIMITIVE");
    expect(text).toContain("MODULE SPLITS");
    expect(text).toContain("PRESERVATIONS");
    expect(text).toContain("WIDE-DEPENDENT WITHOUT COMPOSITION EVIDENCE (1)");
    expect(text).not.toContain("undefined");
  });
});

/** A root that constructs one implementation per responsibility, plus an a-local constant. */
function compositionFixture(): Record<string, string> {
  const files: Record<string, string> = {
    "src/bootstrap.ts":
      importOf("src/bootstrap.ts", "src/a/impl.ts", "ImplA") +
      importOf("src/bootstrap.ts", "src/b/impl.ts", "ImplB") +
      importOf("src/bootstrap.ts", "src/c/impl.ts", "ImplC") +
      "export const A_LIMIT = 5;\n" +
      "export function boot() { return [new ImplA(), new ImplB(), new ImplC()]; }\n",
    "src/index.ts": 'export { boot } from "./bootstrap";\n',
  };
  for (const dir of ["a", "b", "c"]) {
    const upper = dir.toUpperCase();
    files[`src/${dir}/contracts.ts`] =
      `export interface Port${upper} { run(): void }\n`;
    files[`src/${dir}/impl.ts`] =
      importOf(
        `src/${dir}/impl.ts`,
        `src/${dir}/contracts.ts`,
        `Port${upper}`
      ) +
      `export class Impl${upper} implements Port${upper} { run(): void {} }\n`;
  }
  files["src/a/use.ts"] =
    importOf("src/a/use.ts", "src/a/impl.ts", "ImplA") +
    importOf("src/a/use.ts", "src/bootstrap.ts", "A_LIMIT") +
    "export const useA = { impl: new ImplA(), limit: A_LIMIT };\n";
  return files;
}

describe("composition root", () => {
  const report = rewiringOf(compositionFixture());
  // `ImplA` splits between use.ts and the root, so use.ts is its own region.
  const regionUse = responsibilityOf(report, "src/a/use.ts") ?? "";

  it("reads construction across responsibilities as composition and preserves the root", () => {
    const root = getCompositionEvidence(report, "src/bootstrap.ts");
    expect(root).toMatchObject({
      ambiguity: "wide-dependent",
      compositionRoot: true,
      exportedSymbols: 2,
      roles: ["composition"],
      status: "unresolved",
      wiring: {
        argument: 0,
        called: 0,
        collected: 0,
        constructed: 3,
        rendered: 0,
      },
    });
    expect(root?.responsibilities).toHaveLength(3);
    expect(root?.wiredResponsibilities).toHaveLength(3);
    expect(kindsFor(report, "src/bootstrap.ts")).toEqual([
      "preserve-current",
      "preserve-composition-root",
    ]);
    const preserve = scenario(
      report,
      "src/bootstrap.ts",
      "preserve-composition-root"
    );
    expect(preserve.preservations).toEqual(
      expect.arrayContaining(["module-identity", "composition-role"])
    );
    expect(preserve.rationale.facts).toContain(
      "1 responsibility-local declarations served elsewhere have their own scenarios"
    );
    expect(report.summary.composition.wideDependents).toEqual({
      roots: 1,
      total: 1,
      unclear: 0,
    });
  });

  it("still colocates the root's stray local constant while preserving the wiring", () => {
    const key = `src/bootstrap.ts|${regionUse}`;
    expect(kindsFor(report, key)).toEqual([
      "preserve-current",
      "colocate-primitive",
    ]);
    const colocate = scenario(report, key, "colocate-primitive");
    expect(colocate.subject.symbolIds).toEqual([
      id("src/bootstrap.ts", "A_LIMIT"),
    ]);
    expect(colocate.proposed.candidateModules).toEqual([
      {
        evidence: [
          "dedicated-role-module",
          "only-module-in-responsibility",
          "same-responsibility",
        ],
        module: "src/a/use.ts",
      },
    ]);
    // The only module of the target responsibility is the consumer itself:
    // the edge disappears and nothing is added.
    expect(colocate.effects.dependencies).toMatchObject({
      edgesAdded: 0,
      edgesRemoved: 1,
    });
    expect(colocate.effects.moduleComposition.modules).toEqual({
      after: 9,
      before: 9,
    });
    expect(colocate.preservations).toContain("composition-role");
    expect(colocate.uncertainties.map((u) => u.reason)).toContain(
      "composition-root-membership"
    );
    expect(colocate.uncertainties.map((u) => u.reason)).toContain(
      "movement-closure-incomplete"
    );
  });

  it("does not propose splitting or moving the root itself", () => {
    expect(
      getScenariosForModule(report, "src/bootstrap.ts").map((s) => s.kind)
    ).not.toContain("split-module-by-responsibility");
  });
});

/**
 * A responsibility-local mixed-role module beside a package that keeps
 * contracts in dedicated modules (a, b, c), and the same module without
 * that convention.
 */
function roleFixture(withConvention: boolean): Record<string, string> {
  const files: Record<string, string> = {
    "src/index.ts": 'export * from "./z/use";\n',
    "src/z/mixed.ts":
      "export interface ZPort1 { run(): void }\n" +
      "export interface ZPort2 { stop(): void }\n" +
      "export function zRun(): number { return 1; }\n" +
      "export function zStop(): number { return 2; }\n",
    "src/z/use.ts":
      importOf(
        "src/z/use.ts",
        "src/z/mixed.ts",
        "ZPort1, ZPort2, zRun, zStop"
      ) +
      "export const useZ: [ZPort1, ZPort2, number, number] = [{ run() {} }, { stop() {} }, zRun(), zStop()];\n",
  };
  if (withConvention) {
    for (const dir of ["a", "b", "c"]) {
      files[`src/${dir}/contracts.ts`] =
        `export interface Port${dir} { run(): void }\n`;
      files[`src/${dir}/impl.ts`] =
        importOf(
          `src/${dir}/impl.ts`,
          `src/${dir}/contracts.ts`,
          `Port${dir}`
        ) +
        `export class Impl${dir} implements Port${dir} { run(): void {} }\n`;
    }
  }
  return files;
}

describe("split by role", () => {
  it("separates roles when the package already keeps contracts in dedicated modules", () => {
    const report = rewiringOf(roleFixture(true));
    expect(kindsFor(report, "src/z/mixed.ts")).toEqual([
      "preserve-current",
      "split-module-by-role",
    ]);
    const split = scenario(report, "src/z/mixed.ts", "split-module-by-role");
    expect(split.proposed.scope).toBe("dedicated-role-modules");
    expect(
      split.proposed.separated?.map((g) =>
        "role" in g ? `${g.role} ${g.symbolIds.length}` : g.key
      )
    ).toEqual(["behavior 2", "contract 2"]);
    expect(split.effects.conventions).toEqual({
      alignment: "matches-convention",
      conventionIds: [
        "contract/responsibility-local/module=dedicated-role-module",
      ],
    });
    expect(split.effects.moduleComposition).toMatchObject({
      modules: { after: 10, before: 9 },
      roleGroups: { after: 1, before: 2 },
    });
    expect(split.closure?.size).toBe("independent");
  });

  it("records the candidate as ineligible without an observed convention", () => {
    const report = rewiringOf(roleFixture(false));
    expect(
      report.families.some((f) => f.subject.key === "src/z/mixed.ts")
    ).toBe(false);
    const candidate = report.candidates.find(
      (c) =>
        c.subject.key === "src/z/mixed.ts" && c.kind === "split-module-by-role"
    );
    expect(candidate?.eligibility).toMatchObject({
      eligible: false,
      missingEvidence: [
        "an observed dedicated-role-module convention for one of the roles",
      ],
    });
    expect(report.summary.families.insufficientEvidence).toBeGreaterThanOrEqual(
      1
    );
  });
});

/** Four regions keep their contract in a dedicated module; region e declares it beside the implementation. */
function outlierFixture(): Record<string, string> {
  const files: Record<string, string> = {
    "src/index.ts": 'export * from "./a/use";\n',
  };
  for (const dir of ["a", "b", "c", "d"]) {
    files[`src/${dir}/contracts.ts`] =
      `export interface Port${dir} { run(): void }\n`;
    files[`src/${dir}/impl.ts`] =
      importOf(`src/${dir}/impl.ts`, `src/${dir}/contracts.ts`, `Port${dir}`) +
      `export class Impl${dir} implements Port${dir} { run(): void {} }\n`;
    files[`src/${dir}/use.ts`] =
      importOf(`src/${dir}/use.ts`, `src/${dir}/contracts.ts`, `Port${dir}`) +
      importOf(`src/${dir}/use.ts`, `src/${dir}/impl.ts`, `Impl${dir}`) +
      `export const use${dir}: Port${dir} = new Impl${dir}();\n`;
  }
  files["src/e/impl.ts"] =
    "export interface Porte { run(): void }\n" +
    "export class Imple implements Porte { run(): void {} }\n";
  files["src/e/use.ts"] =
    importOf("src/e/use.ts", "src/e/impl.ts", "Porte, Imple") +
    "export const usee: Porte = new Imple();\n";
  return files;
}

describe("convention outlier", () => {
  const report = rewiringOf(outlierFixture());

  it("offers alignment for the one contract declared against a strong dedicated-module convention", () => {
    const key = "src/e/impl.ts|align:contract/responsibility-local";
    expect(kindsFor(report, key)).toEqual([
      "preserve-current",
      "align-with-convention",
    ]);
    const align = scenario(report, key, "align-with-convention");
    expect(align.subject.symbolIds).toEqual([id("src/e/impl.ts", "Porte")]);
    expect(align.rationale.sources).toEqual(["convention-outlier"]);
    expect(align.proposed).toMatchObject({
      candidateModules: [],
      scope: "dedicated-role-modules",
    });
    expect(align.effects.conventions).toEqual({
      alignment: "matches-convention",
      conventionIds: [
        "contract/responsibility-local/module=dedicated-role-module",
      ],
    });
    expect(align.effects.moduleComposition).toMatchObject({
      modules: { after: 16, before: 15 },
      roleGroups: { after: 1, before: 2 },
    });
    expect(align.effects.dependencies.edgesRetargeted).toBe(1);
    expect(align.closure?.blockers).toEqual([
      { reason: "reverse-dependency", symbolId: id("src/e/impl.ts", "Imple") },
    ]);
    expect(align.uncertainties.map((u) => u.reason)).toContain(
      "target-module-unresolved"
    );
  });

  it("keeps the dedicated contracts unchanged", () => {
    expect(
      getScenariosByKind(report, "align-with-convention").filter((s) =>
        s.subject.key.endsWith("align:contract/responsibility-local")
      )
    ).toHaveLength(1);
    expect(
      getScenariosForSymbol(report, id("src/a/contracts.ts", "Porta"))
    ).toEqual([]);
  });
});

/**
 * Region A (a1, a2, a3) reaches three deep modules of region B; b1 keeps
 * two callable contracts beside its behavior, consumed by a1, a3, and b2.
 * A seed with 3 consumers is not localized, so it joins nothing; every A
 * module stays below the high-fan-out cutoff.
 */
function surfaceFixture(): Record<string, string> {
  return {
    "src/a/a1.ts":
      importOf("src/a/a1.ts", "src/a/a2.ts", "A2") +
      importOf("src/a/a1.ts", "src/b/b1.ts", "BPort1, BPort2, runB") +
      "export type A1 = [A2, BPort1, BPort2];\nexport const a1 = runB();\n",
    "src/a/a2.ts":
      importOf("src/a/a2.ts", "src/a/a3.ts", "A3") +
      importOf("src/a/a2.ts", "src/b/b2.ts", "B2_CONST") +
      "export interface A2 { a: A3 }\nexport const a2 = B2_CONST;\n",
    "src/a/a3.ts":
      importOf("src/a/a3.ts", "src/b/b1.ts", "BPort1, BPort2") +
      importOf("src/a/a3.ts", "src/b/b3.ts", "B3_CONST") +
      "export interface A3 { p: [BPort1, BPort2] }\nexport const a3 = B3_CONST;\n",
    "src/b/b1.ts":
      importOf("src/b/b1.ts", "src/b/b2.ts", "B2") +
      "export interface BPort1 { run(): void }\n" +
      "export interface BPort2 { stop(): void }\n" +
      "export function runB(): B2 { return { b: 1 }; }\n",
    "src/b/b2.ts":
      importOf("src/b/b2.ts", "src/b/b3.ts", "B3") +
      importOf("src/b/b2.ts", "src/b/b1.ts", "BPort1, BPort2") +
      "export interface B2 { b: number }\nexport const B2_CONST = 2;\n" +
      "export const b2: [B3, BPort1, BPort2] = [{ c: 1 }, { run() {} }, { stop() {} }];\n",
    "src/b/b3.ts":
      "export interface B3 { c: number }\nexport const B3_CONST = 3;\n",
    "src/index.ts": 'export * from "./a/a1";\n',
  };
}

describe("responsibility surfaces", () => {
  const report = rewiringOf(surfaceFixture());
  const regionA = responsibilityOf(report, "src/a/a1.ts") ?? "";
  const regionB = responsibilityOf(report, "src/b/b3.ts") ?? "";
  const key = `${regionA}→${regionB}`;

  it("formalizes a surface where one responsibility reaches several deep modules", () => {
    expect(regionA).not.toBe(regionB);
    expect(kindsFor(report, key)).toEqual([
      "preserve-current",
      "formalize-responsibility-surface",
    ]);
    const surface = scenario(report, key, "formalize-responsibility-surface");
    expect(surface.subject.kind).toBe("responsibility-relationship");
    expect(surface.current.relationship).toEqual({
      moduleEdges: 4,
      sourceModules: 3,
      symbolFlow: 5,
      targetModules: 3,
    });
    expect(surface.proposed.surface?.deepModules).toEqual([
      "src/b/b1.ts",
      "src/b/b2.ts",
      "src/b/b3.ts",
    ]);
    expect(surface.effects.dependencies.deepImports).toEqual({
      after: 1,
      before: 3,
    });
    expect(surface.effects.responsibilityBoundaries.crossEdges).toEqual({
      after: 3,
      before: 4,
    });
    expect(surface.uncertainties.map((u) => u.reason)).toContain(
      "target-module-unresolved"
    );
  });

  it("proposes a contract surface for contracts declared beside behavior, and preserves them too", () => {
    const contractKey = `${key}|contract`;
    expect(kindsFor(report, contractKey)).toEqual([
      "preserve-current",
      "formalize-cross-responsibility-contract",
    ]);
    const formalize = scenario(
      report,
      contractKey,
      "formalize-cross-responsibility-contract"
    );
    expect(formalize.proposed.surface?.symbolIds).toEqual([
      id("src/b/b1.ts", "BPort1"),
      id("src/b/b1.ts", "BPort2"),
    ]);
    expect(formalize.proposed.scope).toBe("cross-responsibility-surface");
    expect(formalize.preservations).toContain("responsibility-ownership");
    expect(kindsFor(report, "src/b/b1.ts|cross-responsibility")).toEqual([
      "preserve-current",
      "preserve-cross-responsibility-contract",
    ]);
  });

  it("treats a symbol with one foreign consumer responsibility as an ordinary dependency", () => {
    const candidate = report.candidates.find(
      (c) =>
        c.subject.key === "src/b/b1.ts|cross-responsibility" &&
        c.kind === "promote-primitive"
    );
    expect(candidate?.eligibility.eligible).toBe(false);
    expect(candidate?.eligibility.reasons[0]).toMatch(expectedTextPattern3);
    expect(getScenariosByKind(report, "promote-primitive")).toEqual([]);
  });
});

/** A seed declared in a and consumed by a, b, c: package-wide at the floor of 3. */
function promotionFixture(): Record<string, string> {
  return {
    "src/a/a1.ts":
      importOf("src/a/a1.ts", "src/a/a2.ts", "A2") +
      "export interface Shared { s: 1 }\nexport type A1 = [A2, Shared];\n",
    "src/a/a2.ts":
      importOf("src/a/a2.ts", "src/a/a1.ts", "Shared") +
      "export interface A2 { a: Shared }\n",
    "src/b/b1.ts":
      importOf("src/b/b1.ts", "src/a/a1.ts", "Shared") +
      importOf("src/b/b1.ts", "src/b/b2.ts", "B2") +
      "export type B1 = [Shared, B2];\n",
    "src/b/b2.ts": "export interface B2 { b: 1 }\n",
    "src/c/c1.ts":
      importOf("src/c/c1.ts", "src/a/a1.ts", "Shared") +
      importOf("src/c/c1.ts", "src/c/c2.ts", "C2") +
      "export type C1 = [Shared, C2];\n",
    "src/c/c2.ts": "export interface C2 { c: 1 }\n",
    "src/index.ts": 'export * from "./a/a1";\n',
  };
}

describe("promotion", () => {
  const report = rewiringOf(promotionFixture());

  it("offers promotion and preservation for a broad symbol declared inside one responsibility", () => {
    const key = "src/a/a1.ts|package-wide";
    expect(kindsFor(report, key)).toEqual([
      "preserve-current",
      "promote-primitive",
      "preserve-package-primitive",
    ]);
    const promote = scenario(report, key, "promote-primitive");
    expect(promote.subject.symbolIds).toEqual([id("src/a/a1.ts", "Shared")]);
    expect(promote.current.locality).toBe(
      "declared-in-one-serving-responsibility"
    );
    expect(promote.effects.locality.after).toBe("declared-at-shared-scope");
    expect(promote.effects.responsibilityBoundaries.crossEdges).toEqual({
      after: 0,
      before: 2,
    });
    expect(promote.effects.responsibilityBoundaries.unresolvedEdges).toEqual({
      after: 3,
      before: 0,
    });
    expect(promote.closure).toMatchObject({
      blockers: [
        { reason: "reverse-dependency", symbolId: id("src/a/a1.ts", "A1") },
      ],
      size: "unresolved",
    });
    expect(promote.uncertainties.map((u) => u.reason)).toContain(
      "closure-blocked"
    );
    expect(promote.uncertainties.map((u) => u.reason)).toContain(
      "package-public-external-impact"
    );
    // Promotion places the group at its measured scope, so that scope is kept.
    expect(promote.preservations).toContain("package-wide-scope");
  });
});

/**
 * `X` in m/m1 serves a alone and is annotated with `Z`, which stays; m1
 * already depends on a2, so importing `Z` back from a would close a cycle.
 */
function cycleFixture(): Record<string, string> {
  return {
    "src/a/a1.ts":
      importOf("src/a/a1.ts", "src/a/a2.ts", "A2") +
      importOf("src/a/a1.ts", "src/m/m1.ts", "X") +
      "export type A1 = [A2];\nexport const a1 = X;\n",
    "src/a/a2.ts": "export interface A2 { a: 1 }\nexport const A_CONST = 1;\n",
    "src/index.ts": 'export * from "./a/a1";\n',
    "src/m/m1.ts":
      importOf("src/m/m1.ts", "src/a/a2.ts", "A_CONST") +
      importOf("src/m/m1.ts", "src/m/m2.ts", "M2") +
      "export interface Z { z: number }\nexport const X: Z = { z: A_CONST };\nexport type M1 = [M2];\n",
    "src/m/m2.ts": "export interface M2 { m: 1 }\n",
  };
}

describe("cycle guard and closure size", () => {
  const report = rewiringOf(cycleFixture());
  const regionA = responsibilityOf(report, "src/a/a1.ts") ?? "";

  it("reports a potential new cycle and a large closure", () => {
    const key = `src/m/m1.ts|${regionA}`;
    const demote = scenario(report, key, "demote-primitive");
    expect(demote.closure).toMatchObject({
      optional: [
        {
          relationships: ["annotation", "type-reference"],
          symbolId: id("src/m/m1.ts", "Z"),
        },
      ],
      size: "large",
    });
    expect(demote.effects.cycles.detail).toMatch(expectedTextPattern2);
    expect(demote.effects.cycles).toMatchObject({
      membership: [],
      outcome: "potential-new-cycle",
    });
    expect(demote.uncertainties.map((u) => u.reason)).toContain(
      "large-closure"
    );
    expect(demote.preservations).not.toContain("cycle-atomicity");
  });
});

/** a1 → helper → core, with the helper thin; a2 → adapter → port/core, with the adapter an implementation. */
function indirectionFixture(): Record<string, string> {
  return {
    "src/a/a1.ts":
      importOf("src/a/a1.ts", "src/helper.ts", "helper") +
      "export const a1 = helper(1);\n",
    "src/a/a2.ts":
      importOf("src/a/a2.ts", "src/adapter.ts", "CoreAdapter") +
      "export const a2 = new CoreAdapter();\n",
    "src/adapter.ts":
      importOf("src/adapter.ts", "src/b/port.ts", "Port") +
      importOf("src/adapter.ts", "src/b/core.ts", "core") +
      "export class CoreAdapter implements Port { run(): number { return core(1); } }\n",
    "src/b/core.ts":
      "export function core(n: number): number { return n * 2; }\n",
    "src/b/port.ts": "export interface Port { run(): number }\n",
    "src/helper.ts":
      importOf("src/helper.ts", "src/b/core.ts", "core") +
      "export function helper(n: number): number { return core(n) + 1; }\n",
    "src/index.ts": 'export * from "./a/a1";\nexport * from "./a/a2";\n',
  };
}

describe("indirection", () => {
  const report = rewiringOf(indirectionFixture());

  it("collapses a thin intermediary onto its providers", () => {
    expect(kindsFor(report, "src/helper.ts")).toEqual([
      "preserve-current",
      "collapse-indirection",
    ]);
    const collapse = scenario(report, "src/helper.ts", "collapse-indirection");
    expect(collapse.proposed.collapse).toEqual({
      consumer: "src/a/a1.ts",
      intermediary: "src/helper.ts",
      providers: ["src/b/core.ts"],
    });
    expect(collapse.effects.dependencies).toMatchObject({
      edgesAdded: 1,
      edgesRemoved: 2,
    });
    expect(collapse.effects.moduleComposition.modules).toEqual({
      after: 6,
      before: 7,
    });
    expect(collapse.effects.cycles.outcome).toBe("none");
  });

  it("keeps an adapter's indirection", () => {
    expect(
      report.families.some((f) => f.subject.key === "src/adapter.ts")
    ).toBe(false);
    const candidate = report.candidates.find(
      (c) =>
        c.subject.key === "src/adapter.ts" && c.kind === "collapse-indirection"
    );
    expect(candidate?.eligibility.eligible).toBe(false);
    expect(candidate?.eligibility.missingEvidence.join(" ")).toMatch(
      expectedTextPattern
    );
  });
});

describe("independence", () => {
  const files = hubFixture();

  it("is byte-identical across workspaces, runs, and input order", () => {
    const one = derive(workspace(files));
    const two = derive(
      workspace(files, {
        "packages/other/package.json": JSON.stringify({ name: "@f/other" }),
        "packages/other/src/index.ts":
          'import { a1 } from "@f/p";\nexport const o = a1;\n',
      })
    );
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));

    const root = workspace(files);
    const local = analyzePackageLocal({ root, target: "packages/p" });
    const topology = analyzeInternalPackageTopology(local);
    const locality = analyzeSymbolLocality(local, topology);
    const responsibilities = analyzeInternalResponsibilities(
      local,
      topology,
      locality
    );
    const primitives = analyzePrimitiveConventions(
      local,
      topology,
      locality,
      responsibilities
    );
    const straight = analyzeInternalRewiring(
      local,
      topology,
      locality,
      responsibilities,
      primitives
    );
    const shuffled = analyzeInternalRewiring(
      {
        ...local,
        declarations: [...local.declarations].reverse(),
        imports: [...local.imports].reverse(),
      },
      {
        ...topology,
        consumedSurface: [...topology.consumedSurface].reverse(),
        edges: [...topology.edges].reverse(),
        modules: [...topology.modules].reverse(),
      },
      locality,
      {
        ...responsibilities,
        relationships: [...responsibilities.relationships].reverse(),
      },
      {
        ...primitives,
        modules: [...primitives.modules].reverse(),
        symbols: [...primitives.symbols].reverse(),
      }
    );
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(straight));
    expect(JSON.stringify(one)).toBe(JSON.stringify(straight));
  });

  it("runs through the library entry point", () => {
    const root = workspace(files);
    const report = runInternalAnalysis({
      root,
      target: "packages/p",
      through: "rewiring",
    }).rewiring;
    expect(report?.schemaVersion).toBe(1);
    expect(report).toBeDefined();
  });
});
