import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { classifySpecifier, resolveBoundary } from "../../src/lib/boundary";
import { renderReport } from "../../src/lib/report";
import type { ReductionOperation, SurfaceReport } from "../../src/lib/types";

const root = join(import.meta.dirname, "fixtures", "deps");

let shared: SurfaceReport;
let satellite: SurfaceReport;
let logger: SurfaceReport;
let parent: SurfaceReport;
let pong: SurfaceReport;
let contract: SurfaceReport;
let metrics: SurfaceReport;
let toolkit: SurfaceReport;

beforeAll(async () => {
  [shared, satellite, logger, parent, pong, contract, metrics, toolkit] =
    await Promise.all([
      analyzeSurface({ root, target: "@deps/shared" }),
      analyzeSurface({ root, target: "@deps/satellite" }),
      analyzeSurface({ root, target: "@deps/logger" }),
      analyzeSurface({ root, target: "@deps/parent" }),
      analyzeSurface({ root, target: "@deps/pong" }),
      analyzeSurface({ root, target: "@deps/contract" }),
      analyzeSurface({ root, target: "@deps/metrics" }),
      analyzeSurface({ root, target: "@deps/toolkit" }),
    ]);
});

function opportunity(report: SurfaceReport, operation: ReductionOperation) {
  const found = report.opportunities.find(
    (entry) => entry.operation === operation
  );
  if (!found) {
    throw new Error(`No ${operation} opportunity`);
  }
  return found;
}

function hasOperation(report: SurfaceReport, operation: ReductionOperation) {
  return report.opportunities.some((entry) => entry.operation === operation);
}

function ineligible(report: SurfaceReport, operation: ReductionOperation) {
  const found = report.ineligibleOperations.find(
    (entry) => entry.operation === operation
  );
  if (!found) {
    throw new Error(`No ineligible record for ${operation}`);
  }
  return found;
}

describe("internalize-symbol", () => {
  it("flags an unused external export at full evidence confidence", () => {
    const internalize = opportunity(satellite, "internalize-symbol");
    expect(internalize.subject).toMatchObject({
      name: "recalibrate",
      type: "symbol",
    });
    expect(internalize.evidenceConfidence).toBe(1);
    expect(internalize.evidence).toContainEqual({
      metric: "externalReferences",
      significance: "strong",
      value: 0,
    });
    expect(internalize.estimatedReduction).toEqual([
      { metric: "publicExports", value: 1 },
    ]);
  });

  it("counts an internally-used export as unused external, not dead code", () => {
    // launchSatellite calls recalibrate internally; only external usage counts
    expect(satellite.summary.unusedExternalExports).toBe(1);
    expect(hasOperation(satellite, "internalize-symbol")).toBe(true);
  });

  it("does not flag a narrow interface consumed via implements", () => {
    const store = contract.symbols.find((symbol) => symbol.name === "Store");
    expect(store?.externalReferences).toBeGreaterThan(0);
    expect(store?.usageContexts.implements).toBe(1);
    expect(hasOperation(contract, "internalize-symbol")).toBe(false);
  });
});

describe("fold-package eligibility gates", () => {
  it("reports a strong candidate for a one-way single-consumer satellite", () => {
    const fold = opportunity(satellite, "fold-package");
    expect(fold.subject.name).toBe("@deps/satellite");
    expect(fold.target?.name).toBe("@deps/parent");
    expect(fold.evidenceConfidence).toBeCloseTo(1);
    expect(fold.evidence).toContainEqual({
      metric: "oneWayDependency",
      significance: "supporting",
      value: true,
    });
    expect(fold.estimatedReduction).toEqual([
      { metric: "packageBoundaries", value: 1 },
      { metric: "potentiallyInternalizedExports", value: 3 },
      { metric: "dependencyEdges", value: 1 },
    ]);
    expect(fold.cautions).toEqual([]);
  });

  it("refuses a two-consumer package however dominant the primary is", () => {
    expect(logger.dependencies.primaryConsumer?.referenceShare).toBeCloseTo(
      5 / 6
    );
    expect(hasOperation(logger, "fold-package")).toBe(false);
    expect(ineligible(logger, "fold-package").failedGates).toEqual([
      { actual: 2, expected: 1, gate: "single-consumer" },
    ]);
  });

  it("keeps the concentration signal on a dominant multi-consumer package without a fold", () => {
    expect(metrics.dependencies.shapeSignals).toEqual([
      "concentrated-consumption",
    ]);
    expect(metrics.dependencies.primaryConsumer?.referenceShare).toBeCloseTo(
      0.8
    );
    expect(hasOperation(metrics, "fold-package")).toBe(false);
    expect(ineligible(metrics, "fold-package").failedGates).toEqual([
      { actual: 3, expected: 1, gate: "single-consumer" },
    ]);
  });

  it("loses its one-way evidence and confidence inside a cycle", () => {
    const fold = opportunity(pong, "fold-package");
    expect(fold.target?.name).toBe("@deps/ping");
    expect(fold.evidence).toContainEqual({
      metric: "oneWayDependency",
      significance: "supporting",
      value: false,
    });
    expect(fold.evidenceConfidence).toBeCloseTo(0.85);
    expect(
      fold.cautions.some((caution) => caution.reason === "dependency-cycle")
    ).toBe(true);
  });

  it("cautions on publishable and designed exports without lowering confidence", () => {
    const fold = opportunity(contract, "fold-package");
    expect(fold.evidenceConfidence).toBeCloseTo(1);
    expect(fold.cautions.map((caution) => caution.reason)).toEqual([
      "publishable",
      "designed-exports",
    ]);
  });
});

describe("designed exports resolution", () => {
  it("recognizes declared subpaths as public and internal paths as deep", () => {
    const boundary = resolveBoundary(root, "@deps/contract");
    expect(classifySpecifier(boundary, "@deps/contract")).toBe("public");
    expect(classifySpecifier(boundary, "@deps/contract/adapter")).toBe(
      "public"
    );
    expect(classifySpecifier(boundary, "@deps/contract/src/adapter")).toBe(
      "deep"
    );
  });

  it("resolves a subpath consumer to public access", () => {
    const makeAdapter = contract.symbols.find(
      (symbol) => symbol.name === "makeAdapter"
    );
    expect(makeAdapter?.access).toBe("public");
    expect(makeAdapter?.consumerPackages).toEqual(["@deps/keeper"]);
  });
});

describe("preserve-shared-boundary eligibility gates", () => {
  it("recognizes a broadly consumed package and emits no fold", () => {
    const preserve = opportunity(shared, "preserve-shared-boundary");
    expect(preserve.evidenceConfidence).toBeCloseTo(0.668_75);
    expect(preserve.evidence).toContainEqual({
      metric: "consumerPackages",
      significance: "strong",
      value: 4,
    });
    expect(hasOperation(shared, "fold-package")).toBe(false);
  });

  it("stays eligible with a dominant-but-not-concentrated consumer", () => {
    expect(toolkit.dependencies.primaryConsumer?.referenceShare).toBeCloseTo(
      0.6
    );
    const preserve = opportunity(toolkit, "preserve-shared-boundary");
    expect(preserve.evidenceConfidence).toBeCloseTo(0.6567, 3);
  });

  it("gates out a concentrated multi-consumer package", () => {
    expect(hasOperation(metrics, "preserve-shared-boundary")).toBe(false);
    expect(
      ineligible(metrics, "preserve-shared-boundary").failedGates
    ).toContainEqual({
      actual: 0.8,
      expected: "< 0.8",
      gate: "primary-reference-share",
    });
  });

  it("gates out packages with too few consumers, listing every failed gate", () => {
    const failed = ineligible(logger, "preserve-shared-boundary").failedGates;
    expect(failed).toContainEqual({
      actual: 2,
      expected: 3,
      gate: "minimum-consumers",
    });
    expect(failed).toContainEqual({
      actual: 5 / 6,
      expected: "< 0.8",
      gate: "primary-reference-share",
    });
  });
});

describe("ranking and rendering", () => {
  it("orders fold candidates before symbol internalization", () => {
    expect(satellite.opportunities.map((entry) => entry.operation)).toEqual([
      "fold-package",
      "internalize-symbol",
    ]);
  });

  it("records no ineligible operations for a consumer-less package", () => {
    expect(parent.ineligibleOperations).toEqual([]);
    expect(
      parent.opportunities.every(
        (entry) => entry.operation === "internalize-symbol"
      )
    ).toBe(true);
  });

  it("renders evidence-confidence and unused-external-export terminology", () => {
    const rendered = renderReport(satellite);
    expect(rendered).toContain("Evidence confidence 100.0%");
    expect(rendered).toContain(
      "INTERNALIZE SYMBOLS  1 unused external export · evidence confidence 100.0%"
    );
    expect(rendered).toContain("UNUSED EXTERNAL EXPORTS");
    expect(rendered).not.toContain("Confidence 100.0%\n");
    const sharedRendered = renderReport(shared);
    expect(sharedRendered).toContain("BOUNDARIES TO PRESERVE");
    expect(sharedRendered).toContain("Evidence confidence 66.9%");
  });
});
