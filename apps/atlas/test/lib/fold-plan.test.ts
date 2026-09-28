import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { buildFoldPackagePlan } from "../../src/lib/fold-plan";
import { renderPlan, renderReport } from "../../src/lib/report";
import type { FoldPackagePlan, SurfaceReport } from "../../src/lib/types";

const root = join(import.meta.dirname, "fixtures", "deps");

let satellite: SurfaceReport;
let contract: SurfaceReport;
let leaf: SurfaceReport;
let pong: SurfaceReport;
let satelliteSrc: SurfaceReport;

beforeAll(async () => {
  [satellite, contract, leaf, pong, satelliteSrc] = await Promise.all([
    analyzeSurface({ root, target: "@deps/satellite" }),
    analyzeSurface({ root, target: "@deps/contract" }),
    analyzeSurface({ root, target: "@deps/leaf" }),
    analyzeSurface({ root, target: "@deps/pong" }),
    analyzeSurface({ root, target: "packages/satellite/src" }),
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

describe("simple fold plan", () => {
  it("describes the satellite → parent fold concretely", () => {
    const plan = foldPlanOf(satellite);
    expect(plan.status).toBe("ready");
    expect(plan.source).toEqual({
      package: "@deps/satellite",
      path: "packages/satellite",
    });
    expect(plan.destination.package).toBe("@deps/parent");
    expect(plan.destination.directory).toBe("src/satellite");
    expect(plan.destination.resolution).toBe("suggested");
    expect(plan.files).toEqual([
      { file: "packages/satellite/src/index.ts", kind: "source" },
    ]);
    expect(plan.dependencyEdges).toEqual([
      {
        fromFile: "packages/parent/src/index.ts",
        toFile: "packages/satellite/src/index.ts",
        typeOnly: false,
      },
    ]);
    expect(plan.externalConsumers).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it("predicts a split certain/potential delta", () => {
    const plan = foldPlanOf(satellite);
    expect(plan.predictedDelta.certain).toEqual({
      filesMoved: 1,
      importSitesRewritten: 2,
      packageBoundaries: -1,
      packageDependencyEdges: -1,
    });
    expect(plan.predictedDelta.potential).toEqual({ exportedSymbols: -3 });
    expect(plan.potentiallyInternalized).toEqual([
      "launchSatellite",
      "recalibrate",
      "SatelliteState",
    ]);
  });
});

describe("semantic edge inventory", () => {
  it("connects consumed symbols with usage counts", () => {
    const plan = foldPlanOf(satellite);
    const names = plan.consumedSurface.map((entry) => entry.symbolName);
    expect(names.sort((a, b) => a.localeCompare(b))).toEqual([
      "launchSatellite",
      "SatelliteState",
    ]);
    const launch = plan.consumedSurface.find(
      (entry) => entry.symbolName === "launchSatellite"
    );
    expect(launch?.references).toBe(1);
    expect(launch?.importSites).toBe(1);
    expect(launch?.usageNamespace).toBe("value");
  });

  it("reports a mixed type/value boundary", () => {
    expect(foldPlanOf(satellite).boundaryUsage).toEqual({
      consumedSymbols: 2,
      importSites: 2,
      moduleEdges: 1,
      usageNamespace: "both",
    });
  });
});

describe("type-only boundary", () => {
  it("preserves the type-only namespace", () => {
    const plan = foldPlanOf(leaf);
    expect(plan.status).toBe("ready");
    expect(plan.destination.package).toBe("@deps/leaf-user");
    expect(plan.boundaryUsage.usageNamespace).toBe("type");
    expect(plan.consumedSurface[0]?.usageNamespace).toBe("type");
  });
});

describe("package metadata impact", () => {
  it("detects the source manifest and the consumer dependency", () => {
    const plan = foldPlanOf(leaf);
    const kinds = plan.packageMetadata.map((impact) => impact.kind);
    expect(kinds).toContain("source-manifest");
    expect(kinds).toContain("consumer-dependency");
    const dependency = plan.packageMetadata.find(
      (impact) => impact.kind === "consumer-dependency"
    );
    expect(dependency?.file).toBe("packages/leaf-user/package.json");
    expect(plan.plannedChanges.map((change) => change.kind)).toContain(
      "remove-package-dependency"
    );
  });

  it("detects a TypeScript project reference", () => {
    const plan = foldPlanOf(leaf);
    const reference = plan.packageMetadata.find(
      (impact) => impact.kind === "project-reference"
    );
    expect(reference?.file).toBe("packages/leaf-user/tsconfig.json");
    expect(plan.plannedChanges.map((change) => change.kind)).toContain(
      "update-project-reference"
    );
  });
});

describe("cautions carried into the plan", () => {
  it("preserves publishable and designed-exports cautions", () => {
    const plan = foldPlanOf(contract);
    expect(plan.status).toBe("ready");
    expect(plan.cautions.map((caution) => caution.reason).sort()).toEqual([
      "designed-exports",
      "publishable",
    ]);
    expect(plan.files.map((file) => file.file)).toEqual([
      "packages/contract/src/adapter.ts",
      "packages/contract/src/index.ts",
    ]);
  });

  it("preserves the dependency-cycle caution", () => {
    const plan = foldPlanOf(pong);
    expect(plan.status).toBe("ready");
    expect(plan.cautions.map((caution) => caution.reason)).toEqual([
      "dependency-cycle",
    ]);
  });
});

describe("unsupported layout", () => {
  it("refuses to plan a non-package fold source", () => {
    expect(
      satelliteSrc.opportunities.some(
        (entry) => entry.operation === "fold-package"
      )
    ).toBe(true);
    const plan = foldPlanOf(satelliteSrc);
    expect(plan.status).toBe("unsupported");
    expect(plan.blockers.map((blocker) => blocker.reason)).toContain(
      "unresolved-package-ownership"
    );
    expect(plan.plannedChanges).toEqual([]);
    expect(plan.predictedDelta).toEqual({ certain: {}, potential: {} });
  });
});

describe("API and rendering", () => {
  it("selects the fold plan for a fold opportunity", () => {
    const opportunity = satellite.opportunities.find(
      (entry) => entry.operation === "fold-package"
    );
    expect(opportunity).toBeDefined();
    if (!opportunity) {
      return;
    }
    expect(buildFoldPackagePlan(satellite, opportunity).source.package).toBe(
      "@deps/satellite"
    );
    expect(() =>
      buildFoldPackagePlan(satellite, {
        ...opportunity,
        operation: "internalize-symbol",
      })
    ).toThrow("buildFoldPackagePlan only selects fold-package plans");
  });

  it("renders the fold plan view", () => {
    const rendered = renderPlan(foldPlanOf(satellite));
    expect(rendered).toContain("PACKAGE FOLD PLAN");
    expect(rendered).toContain("Status       READY");
    expect(rendered).toContain("single consumer");
    expect(rendered).toContain("one-way dependency");
    expect(rendered).toContain("package boundaries        -1");
    expect(rendered).toContain("READ ONLY");
  });

  it("summarizes the fold plan status in the default report", () => {
    expect(renderReport(satellite)).toContain("Plan ready");
  });

  it("keeps internalize plan counts separate from fold plans", () => {
    // satellite has one fold plan and one ready internalize plan
    expect(renderReport(satellite)).toContain("1 plan-ready");
  });
});
