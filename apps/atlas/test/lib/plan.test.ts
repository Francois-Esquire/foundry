import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { buildInternalizationPlan } from "../../src/lib/plan";
import { renderPlan, renderReport } from "../../src/lib/report";
import type { InternalizeSymbolPlan, SurfaceReport } from "../../src/lib/types";

const root = path.join(import.meta.dirname, "fixtures", "deps");

let plans: SurfaceReport;
let star: SurfaceReport;
let multi: SurfaceReport;
let pub: SurfaceReport;
let wild: SurfaceReport;
let shared: SurfaceReport;
let satellite: SurfaceReport;

beforeAll(async () => {
  [plans, star, multi, pub, wild, shared, satellite] = await Promise.all([
    analyzeSurface({ root, target: "@deps/plans" }),
    analyzeSurface({ root, target: "@deps/plans-star" }),
    analyzeSurface({ root, target: "@deps/plans-multi" }),
    analyzeSurface({ root, target: "@deps/plans-pub" }),
    analyzeSurface({ root, target: "@deps/plans-wild" }),
    analyzeSurface({ root, target: "@deps/shared" }),
    analyzeSurface({ root, target: "@deps/satellite" }),
  ]);
});

function planFor(report: SurfaceReport, name: string): InternalizeSymbolPlan {
  const plan = report.plans.find(
    (entry): entry is InternalizeSymbolPlan =>
      entry.operation === "internalize-symbol" && entry.subject.name === name
  );
  if (!plan) {
    throw new Error(`No plan for ${name}`);
  }
  return plan;
}

const READY_DELTA = {
  exportedSymbols: -1,
  externallyUsedSymbols: 0,
  totalSymbols: 0,
  unusedExternalExports: -1,
};

const ZERO_DELTA = {
  exportedSymbols: 0,
  externallyUsedSymbols: 0,
  totalSymbols: 0,
  unusedExternalExports: 0,
};

describe("ready plans", () => {
  it("plans a simple named re-export", () => {
    const plan = planFor(plans, "PlanAlpha");
    expect(plan.status).toBe("ready");
    expect(plan.publicRoutes).toHaveLength(1);
    const route = plan.publicRoutes[0];
    expect(route?.file).toBe("packages/plans/src/index.ts");
    expect(route?.kind).toBe("type-export");
    expect(route?.entrypoint).toBe("@deps/plans");
    expect(route?.chain).toEqual([
      "packages/plans/src/index.ts",
      "packages/plans/src/foo.ts",
    ]);
    expect(plan.plannedChanges).toEqual([
      {
        description:
          'Remove the statement: export type { PlanAlpha } from "./foo";',
        file: "packages/plans/src/index.ts",
        kind: "remove-public-export",
      },
    ]);
    expect(plan.predictedDelta).toEqual(READY_DELTA);
    expect(plan.blockers).toEqual([]);
  });

  it("rewrites a shared export statement for an internally used symbol", () => {
    const plan = planFor(plans, "PlanBeta");
    expect(plan.status).toBe("ready");
    expect(plan.plannedChanges).toEqual([
      {
        description:
          'Remove PlanBeta from: export type { PlanBeta, PlanBetaExtra } from "./bar";',
        file: "packages/plans/src/index.ts",
        kind: "rewrite-public-export",
      },
    ]);
    expect(plan.preservedBehavior).toContain(
      "Declaration remains in packages/plans/src/bar.ts"
    );
    expect(plan.preservedBehavior).toContain(
      "Internal module exports remain unchanged"
    );
  });

  it("plans a direct entrypoint declaration", () => {
    const plan = planFor(plans, "PlanDirect");
    expect(plan.status).toBe("ready");
    expect(plan.publicRoutes[0]?.kind).toBe("named-export");
    expect(plan.publicRoutes[0]?.statement).toBeUndefined();
    expect(plan.plannedChanges).toEqual([
      {
        description:
          "Remove the export modifier from the declaration of PlanDirect.",
        file: "packages/plans/src/index.ts",
        kind: "remove-public-export",
      },
    ]);
    expect(plan.preservedBehavior).not.toContain(
      "Internal module exports remain unchanged"
    );
  });

  it("plans a direct declaration used only inside its own file", () => {
    const plan = planFor(satellite, "recalibrate");
    expect(plan.status).toBe("ready");
    expect(plan.publicRoutes[0]?.kind).toBe("named-export");
  });

  it("resolves a re-export chain to the package-facing route", () => {
    const plan = planFor(plans, "PlanChained");
    expect(plan.status).toBe("ready");
    expect(plan.publicRoutes[0]?.chain).toEqual([
      "packages/plans/src/index.ts",
      "packages/plans/src/mid.ts",
      "packages/plans/src/deep.ts",
    ]);
    expect(plan.plannedChanges).toHaveLength(1);
    expect(plan.plannedChanges[0]?.file).toBe("packages/plans/src/index.ts");
  });
});

describe("export scope", () => {
  function scopeOf(report: SurfaceReport, name: string) {
    const symbol = report.symbols.find((entry) => entry.name === name);
    if (!symbol) {
      throw new Error(`symbol not found: ${name}`);
    }
    return { exported: symbol.exported, packagePublic: symbol.packagePublic };
  }

  it("classifies module-only, package-public, and not-exported symbols", () => {
    // internal.ts exports readBeta; no entrypoint routes it
    expect(scopeOf(plans, "readBeta")).toEqual({
      exported: true,
      packagePublic: false,
    });
    // PlanAlpha is routed through the root entrypoint but externally unused
    expect(scopeOf(plans, "PlanAlpha")).toEqual({
      exported: true,
      packagePublic: true,
    });
  });

  it("treats a symbol reached only via a subpath entrypoint as package-public", () => {
    expect(scopeOf(multi, "PlanExtraOnly").packagePublic).toBe(true);
  });

  it("resolves package-public through a re-export chain", () => {
    // deep.ts → mid.ts → index.ts
    expect(scopeOf(plans, "PlanChained").packagePublic).toBe(true);
  });

  it("keeps an externally used package-public symbol out of the unused set", () => {
    const launch = satellite.symbols.find(
      (entry) => entry.name === "launchSatellite"
    );
    expect(launch?.packagePublic).toBe(true);
    expect(launch?.externalReferences).toBeGreaterThan(0);
    expect(renderReport(satellite)).not.toContain(
      "UNUSED EXTERNAL EXPORTS\n\n  launchSatellite"
    );
  });

  it("counts module-only exports in the summary, not as unused external", () => {
    // readBeta and readDirect are the two module-only exports
    expect(plans.summary.moduleOnlyExports).toBe(2);
    expect(plans.summary.packagePublicSymbols).toBe(
      plans.summary.moduleExportedSymbols - 2
    );
    expect(plans.summary.unusedExternalExports).toBe(
      plans.opportunities.filter(
        (opportunity) => opportunity.operation === "internalize-symbol"
      ).length
    );
    const rendered = renderReport(plans);
    expect(rendered).toContain("MODULE-ONLY EXPORTS");
    expect(rendered).toContain("readBeta");
    expect(rendered).toContain("readDirect");
  });
});

describe("unsupported plans", () => {
  it("refuses a direct declaration imported internally from the entrypoint", () => {
    const plan = planFor(plans, "PlanDirectUsed");
    expect(plan.status).toBe("unsupported");
    expect(plan.blockers.map((blocker) => blocker.reason)).toContain(
      "internal-entrypoint-import"
    );
    expect(plan.predictedDelta).toEqual(ZERO_DELTA);
    expect(plan.preservedBehavior).toEqual([]);
  });

  it("never plans a module-only export — it is not package-public", () => {
    const symbol = plans.symbols.find((entry) => entry.name === "readBeta");
    expect(symbol?.exported).toBe(true);
    expect(symbol?.packagePublic).toBe(false);
    expect(
      plans.opportunities.some(
        (opportunity) => opportunity.subject.name === "readBeta"
      )
    ).toBe(false);
    expect(
      plans.plans.some(
        (plan) =>
          plan.operation === "internalize-symbol" &&
          plan.subject.name === "readBeta"
      )
    ).toBe(false);
  });

  it("refuses star-export exposure", () => {
    const plan = planFor(star, "PlanHidden");
    expect(plan.status).toBe("unsupported");
    expect(plan.publicRoutes[0]?.kind).toBe("star-export");
    const blocker = plan.blockers.find(
      (entry) => entry.reason === "star-export"
    );
    expect(blocker?.detail).toContain('export * from "./hidden"');
    expect(plan.predictedDelta).toEqual(ZERO_DELTA);
  });

  it("refuses wildcard exports subpaths", () => {
    const plan = planFor(wild, "PlanWild");
    expect(plan.status).toBe("unsupported");
    expect(plan.blockers.map((blocker) => blocker.reason)).toContain(
      "wildcard-exports"
    );
  });
});

describe("blocked plans", () => {
  it("blocks a publishable package but keeps the precise plan", () => {
    const plan = planFor(pub, "PlanPublic");
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.map((blocker) => blocker.reason)).toEqual([
      "publishable",
    ]);
    expect(plan.plannedChanges).toHaveLength(1);
    expect(plan.predictedDelta).toEqual(READY_DELTA);
  });
});

describe("multiple entrypoints", () => {
  it("reports every public route and one change per route", () => {
    const plan = planFor(multi, "PlanShared");
    expect(plan.status).toBe("ready");
    expect(plan.publicRoutes.map((route) => route.entrypoint)).toEqual([
      "@deps/plans-multi",
      "@deps/plans-multi/extra",
    ]);
    expect(plan.plannedChanges).toHaveLength(2);
    expect(plan.predictedDelta).toEqual(READY_DELTA);
  });

  it("classifies a direct declaration in a subpath entrypoint", () => {
    const plan = planFor(multi, "PlanExtraOnly");
    expect(plan.status).toBe("ready");
    expect(plan.publicRoutes[0]?.kind).toBe("subpath-export");
  });
});

describe("plan coverage and API", () => {
  it("does not plan externally used symbols", () => {
    expect(
      shared.plans.find(
        (plan) =>
          plan.operation === "internalize-symbol" &&
          plan.subject.name === "sharedInit"
      )
    ).toBeUndefined();
    expect(shared.plans).toHaveLength(shared.summary.unusedExternalExports);
  });

  it("selects the plan for an internalize opportunity", () => {
    const opportunity = plans.opportunities.find(
      (entry) =>
        entry.operation === "internalize-symbol" &&
        entry.subject.name === "PlanAlpha"
    );
    expect(opportunity).toBeDefined();
    if (!opportunity) {
      return;
    }
    expect(buildInternalizationPlan(plans, opportunity).subject.name).toBe(
      "PlanAlpha"
    );
    expect(() =>
      buildInternalizationPlan(plans, {
        ...opportunity,
        operation: "fold-package",
      })
    ).toThrow("buildInternalizationPlan only selects internalize-symbol plans");
  });
});

describe("rendering", () => {
  it("renders a focused plan view", () => {
    const rendered = renderPlan(planFor(plans, "PlanAlpha"));
    expect(rendered).toContain("INTERNALIZATION PLAN");
    expect(rendered).toContain("Status  READY");
    expect(rendered).toContain("PUBLIC ROUTE");
    expect(rendered).toContain("exported symbols         -1");
    expect(rendered).toContain("READ ONLY");
  });

  it("summarizes plan statuses in the default report", () => {
    const rendered = renderReport(plans);
    expect(rendered).toContain("plan-ready");
    expect(rendered).toContain("unsupported");
  });
});
