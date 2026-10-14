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
import {
  getNondominatedScenarios,
  getReviewForFamily,
  getReviewForScenario,
  getReviewForSubject,
  getReviewsByDisposition,
  reviewPackageArchitecture,
} from "../../src/lib/architecture-review";
import type {
  PackageArchitectureReview,
  ReviewedRewiringScenario,
  ScenarioFamilyReview,
} from "../../src/lib/architecture-review-types";
import { PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION } from "../../src/lib/architecture-review-types";
import { runInternalAnalysis } from "../../src/lib/internal-analysis";
import { analyzeInternalResponsibilities } from "../../src/lib/internal-responsibility";
import { analyzeInternalRewiring } from "../../src/lib/internal-rewiring";
import type {
  InternalRewiringReport,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
} from "../../src/lib/internal-rewiring-types";
import { analyzeInternalPackageTopology } from "../../src/lib/internal-topology";
import { analyzePackageLocal } from "../../src/lib/package-local";
import { analyzePrimitiveConventions } from "../../src/lib/primitive-convention";
import { renderPackageArchitectureReview } from "../../src/lib/report-review";
import { analyzeSymbolLocality } from "../../src/lib/symbol-locality";

const expectedTextPattern = /severity|critical|debt|recommend/i;
const expectedTextPattern2 =
  /dominance {3}colocate primitive is dominated by|no scenario dominates/;
const expectedTextPattern3 = /"exactPath"/;
const expectedTextPattern4 =
  /collapse-indirection: no contract, adapter, or implementation role/;
const specifierPattern = /\.tsx?$/;

// V13.5 review. The dominance rules are exercised on synthetic scenario
// families built over a real report's shell, one rule per fixture; the
// preservation, composition-root, convention-outlier, indirection, and
// surface cases run end to end on the V13.4 synthetic packages.

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
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
  return root;
}

function rewiringAt(root: string): InternalRewiringReport {
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

function reviewOf(files: Record<string, string>): {
  rewiring: InternalRewiringReport;
  review: PackageArchitectureReview;
} {
  const rewiring = rewiringAt(workspace(files));
  return { review: reviewPackageArchitecture(rewiring), rewiring };
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

function family(
  review: PackageArchitectureReview,
  id: string
): ScenarioFamilyReview {
  const found = getReviewForFamily(review, id);
  if (found === undefined) {
    throw new Error(`no family review: ${id}`);
  }
  return found;
}

function reviewed(
  review: PackageArchitectureReview,
  familyId: string,
  kind: InternalRewiringScenarioKind
): ReviewedRewiringScenario {
  const found = review.scenarios.find(
    (s) => s.familyId === familyId && s.kind === kind
  );
  if (found === undefined) {
    throw new Error(`no review: ${familyId} ${kind}`);
  }
  return found;
}

function dimension(r: ReviewedRewiringScenario, name: string) {
  const found = r.effects.find((d) => d.dimension === name);
  if (found === undefined) {
    throw new Error(`no dimension: ${name}`);
  }
  return found;
}

// Synthetic families: one subject, scenarios with explicit effects.

const SHELL = rewiringAt(
  workspace({
    "src/a.ts": "export const a = 1;\n",
    "src/index.ts": 'export * from "./a";\n',
  })
);

const same = (n: number) => ({ after: n, before: n });

type Effects = InternalRewiringScenario["effects"];

function synthetic(
  kind: InternalRewiringScenarioKind,
  overrides: Omit<Partial<InternalRewiringScenario>, "effects"> & {
    effects?: Partial<Effects>;
  } = {}
): InternalRewiringScenario {
  const { effects, ...rest } = overrides;
  const preserving = kind.startsWith("preserve");
  return {
    current: { module: "src/hub.ts", scope: "responsibility-local" },
    effects: {
      conventions: { alignment: "no-applicable-convention", conventionIds: [] },
      cycles: { membership: [], outcome: "none" },
      dependencies: {
        edgesAdded: 0,
        edgesRemoved: 0,
        edgesRetargeted: 0,
        modules: [],
      },
      locality: {
        after: "declared-outside-serving-responsibility",
        before: "declared-outside-serving-responsibility",
        symbols: 2,
      },
      moduleComposition: {
        module: "src/hub.ts",
        modules: same(10),
        roleGroups: same(1),
        scopeGroups: same(2),
      },
      responsibilityBoundaries: {
        crossEdges: same(0),
        crossingSymbols: same(0),
        responsibilitiesTouched: [],
        unresolvedEdges: same(0),
        withinEdges: same(0),
      },
      ...effects,
    },
    id: `${kind}:${(rest.id ?? kind).slice(0, 12)}`,
    kind,
    preservations: preserving ? ["symbol-identity", "module-identity"] : [],
    proposed: {
      candidateModules: [],
      exactPath: "deferred",
      scope: resolveScope(preserving, kind),
    },
    provenance: {
      locality: [],
      primitives: [],
      responsibilities: [],
      topology: [],
    },
    rationale: { facts: [], sources: [] },
    subject: {
      key: "src/hub.ts|responsibility:r1",
      kind: "symbol-group",
      module: "src/hub.ts",
      symbolIds: ["packages/p/src/hub.ts#X", "packages/p/src/hub.ts#Y"],
    },
    uncertainties: [],
    ...rest,
  };
}

const moved: Partial<Effects> = {
  locality: {
    after: "declared-in-serving-responsibility",
    before: "declared-outside-serving-responsibility",
    symbols: 2,
  },
};

function resolveScope(
  preserving: boolean,
  kind: InternalRewiringScenarioKind
): "unchanged" | "package-wide" | "responsibility-local" {
  if (preserving) {
    if (kind === "preserve-current") {
      return "unchanged";
    }
    return "package-wide";
  }
  return "responsibility-local";
}

function familyOf(...scenarios: InternalRewiringScenario[]): {
  rewiring: InternalRewiringReport;
  review: PackageArchitectureReview;
  id: string;
} {
  const [first] = scenarios;
  if (first === undefined) {
    throw new Error("empty family");
  }
  const rewiring: InternalRewiringReport = {
    ...SHELL,
    candidates: [],
    composition: [],
    families: [
      {
        preservationOnly: scenarios.every((s) => s.kind.startsWith("preserve")),
        scenarioIds: scenarios.map((s) => s.id),
        subject: first.subject,
      },
    ],
    scenarios,
  };
  return {
    id: first.subject.key,
    review: reviewPackageArchitecture(rewiring),
    rewiring,
  };
}

describe("dominance rules", () => {
  it("lets a measured improvement with no cost dominate the baseline", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("demote-primitive", {
        closure: {
          blockers: [],
          optional: [],
          required: [],
          size: "independent",
          subject: [],
        },
        effects: {
          ...moved,
          responsibilityBoundaries: {
            crossEdges: { after: 0, before: 2 },
            crossingSymbols: { after: 0, before: 2 },
            responsibilitiesTouched: [],
            unresolvedEdges: same(0),
            withinEdges: { after: 2, before: 0 },
          },
        },
      })
    );
    const f = family(review, id);
    expect(f.disposition).toBe("credible-alternative");
    expect(f.dominance).toEqual([
      {
        dominant: "demote-primitive:demote-primi",
        dominated: "preserve-current:preserve-cur",
        improves: ["locality", "responsibility-boundaries"],
      },
    ]);
    expect(f.reasons).toContain("baseline dominated by demote-primitive");
    expect(reviewed(review, id, "preserve-current").status).toBe("baseline");
    expect(reviewed(review, id, "demote-primitive")).toMatchObject({
      dominates: ["preserve-current:preserve-cur"],
      measuredAdvantages: ["locality", "responsibility-boundaries"],
      measuredCosts: [],
      status: "credible",
    });
    expect(review.summary.dominance.alternativeOverBaseline).toBe(1);
    expect(review.summary.lowUncertaintyAlternatives).toEqual([
      "demote-primitive:demote-primi",
    ]);
  });

  it("keeps a locality gain that adds a module as a nondominated tradeoff", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("demote-primitive", {
        effects: {
          ...moved,
          moduleComposition: {
            module: "src/hub.ts",
            modules: { after: 11, before: 10 },
            roleGroups: same(1),
            scopeGroups: same(2),
          },
        },
      })
    );
    const f = family(review, id);
    expect(f.disposition).toBe("credible-alternative");
    expect(f.dominance).toEqual([]);
    expect(f.nondominated).toHaveLength(2);
    expect(reviewed(review, id, "demote-primitive")).toMatchObject({
      measuredAdvantages: ["locality"],
      measuredCosts: ["module-composition"],
      status: "credible",
    });
    // Tradeoffs read from the left scenario's side; the baseline is first.
    expect(f.tradeoffs.map((t) => [t.dimension, t.comparison])).toEqual([
      ["locality", "worse"],
      ["module-composition", "better"],
    ]);
    expect(f.tradeoffs[0]?.left).toBe("preserve-current:preserve-cur");
    expect(review.summary.tradeoffPairs).toEqual([
      { count: 1, dimensions: ["locality", "module-composition"] },
    ]);
  });

  it("blocks dominance both ways on an unresolved closure", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("demote-primitive", {
        closure: {
          blockers: [
            {
              reason: "shared-module-local-dependency",
              symbolId: "packages/p/src/hub.ts#Z",
            },
          ],
          optional: [],
          required: [],
          size: "unresolved",
          subject: ["packages/p/src/hub.ts#X"],
        },
        effects: moved,
        uncertainties: [
          {
            detail: "Z: shared-module-local-dependency",
            reason: "closure-blocked",
          },
        ],
      })
    );
    const f = family(review, id);
    expect(f.disposition).toBe("uncertainty-blocked");
    expect(f.dominance).toEqual([]);
    const demote = reviewed(review, id, "demote-primitive");
    expect(demote.status).toBe("uncertain");
    expect(demote.uncertainty.unresolvedDimensions).toEqual([
      "movement-closure",
    ]);
    expect(dimension(demote, "movement-closure")).toMatchObject({
      certainty: "unresolved",
      conditions: ["closure-blocked: Z: shared-module-local-dependency"],
      direction: "unknown",
    });
    expect(dimension(demote, "locality").certainty).toBe("measured");
    expect(review.summary.highUncertaintyAlternatives).toEqual([]);
  });

  it("lets a required preservation block an otherwise better alternative", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("preserve-package-primitive", {
        preservations: ["symbol-identity", "package-wide-scope"],
      }),
      synthetic("demote-primitive", {
        effects: {
          ...moved,
          responsibilityBoundaries: {
            crossEdges: { after: 1, before: 3 },
            crossingSymbols: same(0),
            responsibilitiesTouched: [],
            unresolvedEdges: same(0),
            withinEdges: same(0),
          },
        },
      })
    );
    const f = family(review, id);
    expect(f.disposition).toBe("preservation-required");
    expect(f.preservationRequirements).toEqual(["package-wide-scope"]);
    expect(f.dominance).toEqual([]);
    expect(reviewed(review, id, "demote-primitive")).toMatchObject({
      preservation: {
        missing: ["package-wide-scope"],
        required: ["package-wide-scope"],
      },
      status: "preservation-conflict",
    });
    expect(
      reviewed(review, id, "preserve-current").preservation.kept
    ).toContain("package-wide-scope");
    expect(review.summary.preservationReasons).toEqual({
      "package-wide-scope": 1,
    });
  });

  it("treats a potential new cycle as a measured cost, not a block", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("demote-primitive", {
        effects: {
          ...moved,
          cycles: { membership: [], outcome: "potential-new-cycle" },
        },
      })
    );
    const f = family(review, id);
    expect(f.disposition).toBe("credible-alternative");
    expect(f.dominance).toEqual([]);
    expect(reviewed(review, id, "demote-primitive")).toMatchObject({
      measuredAdvantages: ["locality"],
      measuredCosts: ["cycles"],
      status: "credible",
    });
    expect(review.summary.tradeoffPairs).toEqual([
      { count: 1, dimensions: ["cycles", "locality"] },
    ]);
  });

  it("lets the baseline dominate a move with no measured benefit", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("demote-primitive", {
        effects: {
          dependencies: {
            edgesAdded: 2,
            edgesRemoved: 1,
            edgesRetargeted: 0,
            modules: [],
          },
        },
      })
    );
    const f = family(review, id);
    expect(f.disposition).toBe("preserve-current");
    expect(f.dominance).toEqual([
      {
        dominant: "preserve-current:preserve-cur",
        dominated: "demote-primitive:demote-primi",
        improves: ["dependency-topology"],
      },
    ]);
    expect(reviewed(review, id, "demote-primitive").status).toBe("dominated");
    expect(review.summary.dominance.baselineOverAlternative).toBe(1);
  });

  it("keeps a partial and a full split nondominated against each other", () => {
    const split = (variant: string, symbols: number, modules: number) =>
      synthetic("split-module-by-responsibility", {
        effects: {
          locality: {
            after: "declared-in-serving-responsibility",
            before: "declared-outside-serving-responsibility",
            symbols,
          },
          moduleComposition: {
            module: "src/hub.ts",
            modules: { after: modules, before: 10 },
            roleGroups: same(1),
            scopeGroups: { after: 4 - (modules - 10), before: 4 },
          },
        },
        id: variant,
        rationale: {
          facts: [`${variant}: separate`],
          sources: ["mixed-scope"],
        },
        subject: { key: "src/hub.ts", kind: "module", module: "src/hub.ts" },
      });
    const { review, id } = familyOf(
      synthetic("preserve-current", {
        subject: { key: "src/hub.ts", kind: "module", module: "src/hub.ts" },
      }),
      split("partial", 2, 11),
      split("full", 5, 13)
    );
    const f = family(review, id);
    expect(f.disposition).toBe("multiple-tradeoffs");
    expect(f.dominance).toEqual([]);
    expect(f.nondominated).toHaveLength(3);
    expect(f.reasons).toContain(
      "no scenario dominates the others on all measured dimensions"
    );
    const partial = reviewed(review, id, "split-module-by-responsibility");
    expect(partial.measuredTradeoffs).toEqual(["module-composition"]);
    expect(review.summary.familySizes).toEqual({
      "1": 0,
      "2": 0,
      "3": 1,
      "4+": 0,
    });
    expect(getReviewForSubject(review, "src/hub.ts")?.complexity).toMatchObject(
      {
        alternatives: 2,
        changingDimensions: 2,
        nondominatedAlternatives: 2,
      }
    );
  });

  it("marks the promote unresolved-edge artifact as unresolved and keeps the primitive", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("preserve-package-primitive", {
        preservations: ["symbol-identity", "package-wide-scope"],
      }),
      synthetic("promote-primitive", {
        effects: {
          locality: {
            after: "declared-at-shared-scope",
            before: "declared-in-one-serving-responsibility",
            symbols: 2,
          },
          responsibilityBoundaries: {
            crossEdges: { after: 0, before: 6 },
            crossingSymbols: same(2),
            responsibilitiesTouched: [],
            unresolvedEdges: { after: 6, before: 0 },
            withinEdges: same(0),
          },
        },
        preservations: ["symbol-identity", "package-wide-scope"],
        proposed: {
          candidateModules: [],
          exactPath: "deferred",
          scope: "package-wide",
        },
      })
    );
    const f = family(review, id);
    expect(f.disposition).toBe("preservation-required");
    expect(f.dominance).toEqual([]);
    const promote = reviewed(review, id, "promote-primitive");
    expect(promote.status).toBe("uncertain");
    expect(promote.preservation.missing).toEqual([]);
    expect(dimension(promote, "responsibility-boundaries")).toMatchObject({
      certainty: "unresolved",
      conditions: [expect.stringContaining("unresolved-edge artifact")],
      direction: "unknown",
    });
    expect(reviewed(review, id, "preserve-package-primitive").status).toBe(
      "preservation"
    );
    expect(review.summary.unresolvedDimensions).toEqual({
      "responsibility-boundaries": 1,
    });
  });

  it("records public exposure and the missing anchor model without comparing them", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("demote-primitive", {
        effects: moved,
        preservations: ["symbol-identity", "public-exposure"],
        uncertainties: [
          {
            detail: "2 package-public symbols",
            reason: "package-public-external-impact",
          },
          { detail: "no anchor model", reason: "internal-anchors-unavailable" },
        ],
      })
    );
    const demote = reviewed(review, id, "demote-primitive");
    expect(demote.status).toBe("credible");
    expect(demote.uncertainty).toEqual({
      conditionalDimensions: [],
      reasons: [
        "package-public-external-impact",
        "internal-anchors-unavailable",
      ],
      standing: [
        "package-public-external-impact",
        "internal-anchors-unavailable",
      ],
      unresolvedDimensions: [],
    });
    expect(family(review, id).dominance).toHaveLength(1);
  });

  it("treats convention alignment as supporting evidence only", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("align-with-convention", {
        effects: {
          conventions: {
            alignment: "matches-convention",
            conventionIds: ["contract/responsibility-local/module=dedicated"],
          },
        },
      })
    );
    const f = family(review, id);
    expect(f.dominance).toEqual([]);
    const align = reviewed(review, id, "align-with-convention");
    expect(align.status).toBe("equivalent");
    expect(dimension(align, "convention-alignment").direction).toBe(
      "increased"
    );
    expect(f.tradeoffs).toEqual([
      expect.objectContaining({
        comparison: "worse",
        dimension: "convention-alignment",
      }),
    ]);
    expect(f.disposition).toBe("preserve-current");
  });

  it("makes a contract formalization a tradeoff inside the surface dimension", () => {
    const { review, id } = familyOf(
      synthetic("preserve-current"),
      synthetic("formalize-cross-responsibility-contract", {
        effects: {
          dependencies: {
            deepImports: { after: 1, before: 3 },
            edgesAdded: 0,
            edgesRemoved: 0,
            edgesRetargeted: 4,
            modules: [],
          },
        },
        proposed: {
          candidateModules: [],
          exactPath: "deferred",
          scope: "cross-responsibility-surface",
          surface: {
            consumerModules: ["src/a.ts", "src/b.ts"],
            deepModules: ["src/x.ts", "src/y.ts", "src/z.ts"],
            responsibility: "responsibility:r1",
            symbolIds: ["packages/p/src/x.ts#P", "packages/p/src/y.ts#Q"],
          },
        },
      })
    );
    const f = family(review, id);
    expect(f.disposition).toBe("credible-alternative");
    expect(f.dominance).toEqual([]);
    const formalize = reviewed(
      review,
      id,
      "formalize-cross-responsibility-contract"
    );
    expect(formalize.measuredTradeoffs).toEqual(["surface-indirection"]);
    expect(dimension(formalize, "surface-indirection")).toMatchObject({
      direction: "mixed",
      measures: [
        { after: 1, before: 3, delta: -2, name: "deepImports" },
        { after: 2, before: 0, delta: 2, name: "surfaceSymbols" },
      ],
    });
  });

  it("makes a redirect conditional on the placement it follows", () => {
    const placement = synthetic("demote-primitive", {
      closure: {
        blockers: [
          { reason: "reverse-dependency", symbolId: "packages/p/src/hub.ts#Z" },
        ],
        optional: [],
        required: [],
        size: "unresolved",
        subject: [],
      },
      effects: moved,
      uncertainties: [
        { detail: "Z: reverse-dependency", reason: "closure-blocked" },
      ],
    });
    const redirectSubject = {
      edges: [{ source: "src/a.ts", target: "src/hub.ts" }],
      key: "responsibility:r1→src/hub.ts",
      kind: "internal-dependency" as const,
      module: "src/hub.ts",
    };
    const redirect = synthetic("redirect-internal-dependency", {
      effects: {
        responsibilityBoundaries: {
          crossEdges: { after: 0, before: 1 },
          crossingSymbols: same(0),
          responsibilitiesTouched: [],
          unresolvedEdges: same(0),
          withinEdges: { after: 1, before: 0 },
        },
      },
      rationale: { facts: [`follows ${placement.id}`], sources: [] },
      subject: redirectSubject,
    });
    const base = synthetic("preserve-current");
    const redirectBase = synthetic("preserve-current", {
      id: "redirect-base",
      subject: redirectSubject,
    });
    const rewiring: InternalRewiringReport = {
      ...SHELL,
      candidates: [],
      composition: [],
      families: [
        {
          preservationOnly: false,
          scenarioIds: [redirectBase.id, redirect.id],
          subject: redirectSubject,
        },
        {
          preservationOnly: false,
          scenarioIds: [base.id, placement.id],
          subject: base.subject,
        },
      ],
      scenarios: [redirectBase, redirect, base, placement],
    };
    const review = reviewPackageArchitecture(rewiring);
    const followed = reviewed(
      review,
      redirectSubject.key,
      "redirect-internal-dependency"
    );
    expect(followed.status).toBe("uncertain");
    expect(dimension(followed, "responsibility-boundaries")).toMatchObject({
      certainty: "conditional",
      conditions: [
        `follows demote-primitive ${placement.id}, which is uncertain`,
      ],
    });
    expect(family(review, redirectSubject.key).disposition).toBe(
      "uncertainty-blocked"
    );
  });
});

// End-to-end on synthetic packages.

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
  const { review, rewiring } = reviewOf(compositionFixture());

  it("keeps the root and reviews its embedded local constant on its own", () => {
    expect(review.schemaVersion).toBe(
      PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION
    );
    expect(review.package).toEqual(rewiring.package);
    const root = family(review, "src/bootstrap.ts");
    expect(root.disposition).toBe("preservation-required");
    expect(root.preservationRequirements).toEqual(["composition-role"]);
    expect(root.baselineKind).toBe("preserve-current");
    const local = review.families.find(
      (f) => f.id.startsWith("src/bootstrap.ts|") && f.id !== "src/bootstrap.ts"
    );
    expect(local?.disposition).toBe("credible-alternative");
    expect(local?.preservationRequirements).toEqual([]);
    const colocate = review.scenarios.find(
      (s) => s.familyId === local?.id && s.kind === "colocate-primitive"
    );
    expect(colocate?.status).toBe("credible");
    expect(colocate?.measuredAdvantages).toEqual([
      "locality",
      "responsibility-boundaries",
      "dependency-topology",
      "module-composition",
    ]);
    expect(colocate?.dominates).toEqual([local?.baseline]);
    expect(colocate?.uncertainty.standing).toContain(
      "composition-root-membership"
    );
    const subject = getReviewForSubject(review, "src/bootstrap.ts");
    // The constant's family, the redirect that follows it, and the root itself.
    expect(subject?.families).toHaveLength(3);
    expect(subject?.families).toContain(local?.id);
    expect(subject?.families).toContain("src/bootstrap.ts");
    expect(subject?.currentEvidence).toMatchObject({
      compositionRoles: ["composition"],
      compositionRoot: true,
    });
    expect(subject?.dispositions).toMatchObject({
      "credible-alternative": 2,
      "preservation-required": 1,
    });
    expect(review.summary.compositionRootsPreserved).toBe(1);
  });
});

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
  const { review } = reviewOf(outlierFixture());
  const key = "src/e/impl.ts|align:contract/responsibility-local";

  it("does not let convention support outweigh a blocked closure and a new module", () => {
    const f = family(review, key);
    expect(f.disposition).toBe("uncertainty-blocked");
    expect(f.dominance).toEqual([]);
    const align = reviewed(review, key, "align-with-convention");
    expect(align.status).toBe("uncertain");
    expect(align.measuredAdvantages).toEqual([]);
    expect(dimension(align, "convention-alignment").direction).toBe(
      "increased"
    );
    expect(dimension(align, "movement-closure").certainty).toBe("unresolved");
    expect(dimension(align, "module-composition")).toMatchObject({
      certainty: "conditional",
      direction: "mixed",
    });
    expect(
      review.summary.conventions.supportedUncertain
    ).toBeGreaterThanOrEqual(1);
    expect(review.summary.conventions.supportedCredible).toBe(0);
  });
});

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
  const { review } = reviewOf(indirectionFixture());

  it("keeps a thin helper's behavior as a condition on collapsing it", () => {
    const f = family(review, "src/helper.ts");
    expect(f.disposition).toBe("credible-alternative");
    const collapse = reviewed(review, "src/helper.ts", "collapse-indirection");
    expect(collapse.status).toBe("credible");
    expect(collapse.measuredAdvantages).toContain("dependency-topology");
    expect(family(review, "src/helper.ts").dominance).toEqual([]);
    expect(dimension(collapse, "module-composition")).toMatchObject({
      certainty: "conditional",
      conditions: ["the intermediary's 1 statements move to its consumer"],
    });
    expect(dimension(collapse, "surface-indirection").measures).toEqual([
      {
        after: 1,
        before: 0,
        comparison: "none",
        delta: 1,
        name: "absorbedStatements",
      },
    ]);
  });

  it("reviews the adapter as insufficient evidence with V13.4's reason", () => {
    const adapter = family(review, "src/adapter.ts");
    expect(adapter.disposition).toBe("insufficient-evidence");
    expect(adapter.scenarios).toEqual([]);
    expect(adapter.missingEvidence.join(" ")).toMatch(expectedTextPattern4);
    expect(review.summary.insufficientEvidenceReasons[0]?.count).toBe(1);
    expect(getReviewsByDisposition(review, "insufficient-evidence")).toContain(
      adapter
    );
  });
});

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

describe("responsibility surface", () => {
  const { review, rewiring } = reviewOf(surfaceFixture());
  const key = rewiring.families.find(
    (f) => f.subject.kind === "responsibility-relationship"
  )?.subject.key;

  it("keeps deep-import reduction and surface size as separate measures", () => {
    if (key === undefined) {
      throw new Error("no relationship family");
    }
    const f = family(review, key);
    const surface = reviewed(review, key, "formalize-responsibility-surface");
    // Deep imports fall while the surface exposes symbols: a tradeoff inside one dimension.
    expect(surface.measuredTradeoffs).toEqual(["surface-indirection"]);
    expect(dimension(surface, "surface-indirection")).toMatchObject({
      direction: "mixed",
      measures: [
        expect.objectContaining({
          after: 1,
          before: 3,
          comparison: "lower",
          name: "deepImports",
        }),
        expect.objectContaining({ before: 0, name: "surfaceSymbols" }),
      ],
    });
    expect(f.nondominated).toContain(surface.scenarioId);
    expect(review.summary.responsibilityDependentAlternatives).toBeGreaterThan(
      0
    );
    expect(getReviewForSubject(review, key)?.subject.kind).toBe(
      "responsibility-relationship"
    );
  });
});

describe("independence", () => {
  const files = compositionFixture();

  it("is byte-identical across workspaces, runs, and input order", () => {
    const a = rewiringAt(workspace(files));
    const b = rewiringAt(workspace(files));
    const left = JSON.stringify(reviewPackageArchitecture(a));
    expect(JSON.stringify(reviewPackageArchitecture(b))).toBe(left);
    expect(JSON.stringify(reviewPackageArchitecture(a))).toBe(left);
    const reversed: InternalRewiringReport = {
      ...a,
      candidates: [...a.candidates].reverse(),
      composition: [...a.composition].reverse(),
      families: [...a.families].reverse(),
      scenarios: [...a.scenarios].reverse(),
    };
    expect(JSON.stringify(reviewPackageArchitecture(reversed))).toBe(left);
    expect(left).not.toContain(tmpdir());
    expect(left).not.toMatch(expectedTextPattern3);
  });

  it("answers the query helpers and renders", () => {
    const rewiring = rewiringAt(workspace(files));
    const review = reviewPackageArchitecture(rewiring);
    const root = family(review, "src/bootstrap.ts");
    expect(root.baseline).toBeDefined();
    expect(getReviewForScenario(review, root.baseline ?? "")?.status).toBe(
      "baseline"
    );
    expect(
      getNondominatedScenarios(review, root.id).map((s) => s.scenarioId)
    ).toEqual(root.nondominated);
    expect(getNondominatedScenarios(review).length).toBeGreaterThan(
      root.nondominated.length
    );
    const text = renderPackageArchitectureReview(review, rewiring);
    expect(text).toContain("PACKAGE ARCHITECTURE REVIEW");
    expect(text).toContain("PRESERVATIONS (1)");
    expect(text).toContain("MODULE src/bootstrap.ts");
    expect(text).toContain("preservation required · requires composition-role");
    expect(text).toContain("CREDIBLE ALTERNATIVES");
    expect(text).toMatch(expectedTextPattern2);
    expect(text).not.toMatch(expectedTextPattern);
  });

  it("runs through the library entry point", () => {
    const root = workspace(files);
    const report = runInternalAnalysis({
      root,
      target: "packages/p",
      through: "review",
    }).review;
    expect(report?.schemaVersion).toBe(1);
    expect(report).toBeDefined();
  });
});
