import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { buildPlanIntelligence } from "../../src/lib/intelligence";
import { renderPlan, renderReport } from "../../src/lib/report";
import type {
  FoldPackagePlan,
  InternalizeSymbolPlan,
  SurfaceReport,
} from "../../src/lib/types";
import { planFingerprint } from "../../src/lib/validate";

const root = join(import.meta.dirname, "fixtures", "deps");

let satellite: SurfaceReport;
let leaf: SurfaceReport;
let contract: SurfaceReport;
let pong: SurfaceReport;
let plans: SurfaceReport;
let plansWild: SurfaceReport;

beforeAll(async () => {
  [satellite, leaf, contract, pong, plans, plansWild] = await Promise.all([
    analyzeSurface({ root, target: "@deps/satellite" }),
    analyzeSurface({ root, target: "@deps/leaf" }),
    analyzeSurface({ root, target: "@deps/contract" }),
    analyzeSurface({ root, target: "@deps/pong" }),
    analyzeSurface({ root, target: "@deps/plans" }),
    analyzeSurface({ root, target: "@deps/plans-wild" }),
  ]);
});

function foldPlanOf(report: SurfaceReport): FoldPackagePlan {
  const plan = report.plans.find(
    (entry): entry is FoldPackagePlan => entry.operation === "fold-package"
  );
  if (!plan) {
    throw new Error("No fold plan in report");
  }
  return plan;
}

function internalizePlanOf(
  report: SurfaceReport,
  name: string
): InternalizeSymbolPlan {
  const plan = report.plans.find(
    (entry): entry is InternalizeSymbolPlan =>
      entry.operation === "internalize-symbol" && entry.subject.name === name
  );
  if (!plan) {
    throw new Error(`No internalize plan for ${name}`);
  }
  return plan;
}

describe("fold plan scale", () => {
  it("measures a tiny fold exactly", () => {
    const { intelligence } = foldPlanOf(leaf);
    expect(intelligence?.scale).toEqual({
      files: { config: 0, other: 0, source: 1, test: 0, total: 1 },
      imports: { moduleEdges: 1, sites: 1 },
      symbols: {
        externallyUsed: 1,
        moduleExported: 1,
        packagePublic: 1,
        total: 1,
      },
    });
  });

  it("measures a multi-file fold", () => {
    const plan = foldPlanOf(contract);
    const { intelligence } = plan;
    expect(intelligence?.scale.files.total).toBe(2);
    expect(intelligence?.scale.symbols.packagePublic).toBe(
      contract.summary.packagePublicSymbols
    );
    expect(intelligence?.scale.symbols.externallyUsed).toBe(
      contract.summary.externallyUsedSymbols
    );
    expect(intelligence?.surface.potentiallyInternalizedSymbols).toBe(
      plan.potentiallyInternalized.length
    );
  });
});

describe("surface ratios", () => {
  it("computes consumed and unused ratios", () => {
    const surface = foldPlanOf(satellite).intelligence?.surface;
    // satellite: 3 exported, 2 externally used, 1 unused
    expect(surface?.consumedSurfaceRatio).toBeCloseTo(2 / 3);
    expect(surface?.unusedExternalSurfaceRatio).toBeCloseTo(1 / 3);
    expect(surface?.referenceDensity).not.toBeNull();
  });

  it("returns null ratios for a zero-export surface", () => {
    // doctored report (deliberate): the builder must not divide by zero
    const doctored: SurfaceReport = {
      ...satellite,
      summary: {
        ...satellite.summary,
        externallyUsedSymbols: 0,
        packagePublicSymbols: 0,
        unusedExternalExports: 0,
      },
    };
    const { surface } = buildPlanIntelligence(foldPlanOf(satellite), doctored);
    expect(surface.consumedSurfaceRatio).toBeNull();
    expect(surface.unusedExternalSurfaceRatio).toBeNull();
  });
});

describe("boundary flow", () => {
  it("describes a one-way fold boundary", () => {
    expect(foldPlanOf(satellite).intelligence?.boundary.flow).toEqual({
      cycle: false,
      destinationToSource: true,
      sourceToDestination: false,
    });
  });

  it("marks a cyclical boundary", () => {
    expect(foldPlanOf(pong).intelligence?.boundary.flow?.cycle).toBe(true);
  });
});

describe("intent context", () => {
  it("exposes anchor intent on an anchored fold plan", async () => {
    const anchoredConfig: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      anchors: [
        { reason: "Intentional subsystem boundary", target: "@deps/satellite" },
      ],
    };
    const report = await analyzeSurface({
      config: anchoredConfig,
      root,
      target: "@deps/satellite",
    });
    const intent = foldPlanOf(report).intelligence?.intent;
    expect(intent?.anchored).toBe(true);
    expect(intent?.anchors).toEqual([
      { reason: "Intentional subsystem boundary", target: "@deps/satellite" },
    ]);
  });

  it("carries publishable and designed-exports cautions as intent", () => {
    const intent = foldPlanOf(contract).intelligence?.intent;
    expect(intent?.publishable).toBe(true);
    expect(intent?.designedExports).toBe(true);
    expect(intent?.anchored).toBe(false);
  });
});

describe("internalization intelligence", () => {
  it("measures plan scale and route burden", () => {
    const { intelligence } = internalizePlanOf(plans, "PlanBeta");
    expect(intelligence?.scale.files.total).toBe(1);
    expect(intelligence?.surface.publicRoutes).toEqual({
      supported: 1,
      total: 1,
      unsupported: 0,
    });
    expect(intelligence?.surface.potentiallyInternalizedSymbols).toBe(1);
    expect(intelligence?.boundary.packageBoundariesAffected).toBe(0);
    expect(intelligence?.consequence.certain.exportedSymbols).toBe(-1);
    expect(intelligence?.consequence.potential).toEqual({});
  });

  it("counts unsupported routes on an unsupported plan", () => {
    const { intelligence } = internalizePlanOf(plans, "PlanDirectUsed");
    expect(intelligence?.surface.publicRoutes?.unsupported).toBeGreaterThan(0);
  });
});

describe("unsupported reason aggregation", () => {
  it("aggregates distinct blocker reasons across unsupported plans", () => {
    const summary = plans.operators.find(
      (operator) => operator.id === "internalize-export"
    );
    // readBeta and readDirect are module-only now, so they never become
    // opportunities; only PlanDirectUsed's entrypoint import remains
    expect(summary?.unsupportedReasons).toEqual({
      "internal-entrypoint-import": 1,
    });
  });

  it("counts a package-level blocker once per invalidated plan", () => {
    const summary = plansWild.operators.find(
      (operator) => operator.id === "internalize-export"
    );
    expect(summary?.unsupportedReasons["wildcard-exports"]).toBe(
      summary?.plans.unsupported
    );
  });
});

describe("stability and rendering", () => {
  it("excludes intelligence from the plan fingerprint", () => {
    const plan = foldPlanOf(satellite);
    expect(plan.intelligence).toBeDefined();
    expect(planFingerprint(plan)).toBe(plan.fingerprint);
  });

  it("adds a compact scale line to the default fold report", () => {
    expect(renderReport(satellite)).toContain(
      "Plan ready · 1 file · 2 consumed / 3 public"
    );
  });

  it("summarizes unsupported reasons in the default report", () => {
    expect(renderReport(plans)).toContain(
      "Unsupported: internal-entrypoint-import 1"
    );
  });

  it("renders intelligence sections in the fold plan view", () => {
    const rendered = renderPlan(foldPlanOf(satellite));
    expect(rendered).toContain("PLAN SCALE");
    expect(rendered).toContain("consumed / exported");
    expect(rendered).toContain("INTENT");
    expect(rendered).toContain("destination → source  yes");
  });

  it("renders compact intelligence in the internalization plan view", () => {
    const rendered = renderPlan(internalizePlanOf(plans, "PlanBeta"));
    expect(rendered).toContain("files affected  1");
    expect(rendered).toContain("boundary preserved  yes");
  });
});
