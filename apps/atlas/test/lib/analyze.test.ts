import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { canonicalizeSemanticsArtifact } from "../../src/lib/semantics-equivalence";
import type { SurfaceReport, SurfaceSymbol } from "../../src/lib/types";

const root = join(import.meta.dirname, "fixtures", "workspace");
/** Churn recency is measured against a clock; pin it so runs compare equal. */
const now = new Date("2027-01-01T00:00:00Z");

let report: SurfaceReport;

function symbol(name: string): SurfaceSymbol {
  const found = report.symbols.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`symbol not found: ${name}`);
  }
  return found;
}

beforeAll(async () => {
  report = await analyzeSurface({
    now,
    root,
    target: "packages/orders",
    tsconfig: "tsconfig.json",
  });
});

describe("target", () => {
  it("identifies the package boundary", () => {
    expect(report.target).toEqual({
      boundaryType: "package",
      name: "@repo/orders",
      path: "packages/orders",
    });
  });

  it("resolves a package name target to the same boundary", async () => {
    const byName = await analyzeSurface({
      root,
      target: "@repo/orders",
      tsconfig: "tsconfig.json",
    });
    expect(byName.target.path).toBe("packages/orders");
  });
});

describe("symbol inventory", () => {
  it("counts top-level declarations once, including barreled symbols", () => {
    // order.ts: Order, Store, OrderStatus, createOrder, normalizeOrder,
    // OrderParser, ORDER_LIMIT, helper — testing.ts: makeTestOrder
    expect(report.summary.totalSymbols).toBe(9);
    expect(
      report.symbols.filter((entry) => entry.name === "Order")
    ).toHaveLength(1);
  });

  it("counts internal-only declarations as unexported", () => {
    expect(symbol("helper").exported).toBe(false);
  });

  it("counts exported and externally used symbols", () => {
    expect(report.summary.moduleExportedSymbols).toBe(8);
    expect(report.summary.packagePublicSymbols).toBe(8);
    expect(report.summary.moduleOnlyExports).toBe(0);
    expect(report.summary.externallyUsedSymbols).toBe(7);
    expect(report.summary.unusedExternalExports).toBe(1);
  });

  it("computes ratios", () => {
    expect(report.summary.declaredSurfaceRatio).toBeCloseTo(8 / 9);
    expect(report.summary.externalSurfaceRatio).toBeCloseTo(7 / 9);
    expect(report.summary.exportUtilization).toBeCloseTo(7 / 8);
  });
});

describe("unused external exports", () => {
  it("reports exports with no external references", () => {
    const normalizeOrder = symbol("normalizeOrder");
    expect(normalizeOrder.exported).toBe(true);
    expect(normalizeOrder.externalReferences).toBe(0);
    expect(normalizeOrder.externalImportSites).toBe(0);
    expect(normalizeOrder.access).toBe("unused");
    expect(normalizeOrder.usageNamespace).toBe("none");
  });
});

describe("distribution", () => {
  it("tracks references, import sites, and consumer boundaries", () => {
    const createOrder = symbol("createOrder");
    expect(createOrder.externalReferences).toBe(4);
    expect(createOrder.externalImportSites).toBe(2);
    expect(createOrder.consumerPackages).toEqual([
      "@repo/billing",
      "@repo/checkout",
    ]);
    expect(createOrder.consumerModules).toEqual([
      "packages/billing/src/index.ts",
      "packages/checkout/src/index.ts",
    ]);
  });

  it("distinguishes reference volume from consumer spread", () => {
    const createOrder = symbol("createOrder");
    expect(createOrder.consumers[0]).toEqual({
      boundary: "@repo/checkout",
      importSites: 1,
      references: 3,
      usageContexts: { call: 3 },
      usageNamespace: "value",
    });
    expect(createOrder.consumers[1]).toEqual({
      boundary: "@repo/billing",
      importSites: 1,
      references: 1,
      usageContexts: { call: 1 },
      usageNamespace: "value",
    });
    expect(createOrder.primaryConsumerShare).toBeCloseTo(3 / 4);
  });

  it("reports fully concentrated consumers", () => {
    const parser = symbol("OrderParser");
    expect(parser.consumerPackages).toEqual(["@repo/checkout"]);
    expect(parser.primaryConsumerShare).toBe(1);
  });
});

describe("usage namespace and contexts", () => {
  it("classifies type-only usage", () => {
    const order = symbol("Order");
    expect(order.usageNamespace).toBe("type");
    expect(order.usageContexts["parameter-type"]).toBeGreaterThanOrEqual(1);
    expect(order.usageContexts["return-type"]).toBeGreaterThanOrEqual(1);
    expect(order.usageContexts["property-type"]).toBeGreaterThanOrEqual(1);
  });

  it("classifies runtime usage with call contexts", () => {
    const createOrder = symbol("createOrder");
    expect(createOrder.usageNamespace).toBe("value");
    expect(createOrder.usageContexts.call).toBe(4);
  });

  it("records implements", () => {
    expect(symbol("Store").usageContexts.implements).toBe(1);
  });

  it("records construct", () => {
    expect(symbol("OrderParser").usageContexts.construct).toBe(1);
  });
});

describe("public versus deep access", () => {
  it("labels entry-point imports public", () => {
    expect(symbol("OrderStatus").access).toBe("public");
    expect(symbol("createOrder").access).toBe("public");
  });

  it("labels internal-path imports deep", () => {
    expect(symbol("ORDER_LIMIT").access).toBe("deep");
  });

  it("labels declared subpath exports public", () => {
    expect(symbol("makeTestOrder").access).toBe("public");
  });
});

describe("determinism", () => {
  it("orders symbols by declaration path", () => {
    const files = report.symbols.map((entry) => entry.declarationFile);
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
  });

  it("produces identical JSON across runs", async () => {
    const again = await analyzeSurface({
      now,
      root,
      target: "packages/orders",
      tsconfig: "tsconfig.json",
    });
    // `recenteringCandidates.*.summary.runtimeMs` is the one volatile field
    const canonical = (value: SurfaceReport) =>
      JSON.stringify(canonicalizeSemanticsArtifact("packages/x.json", value));
    expect(canonical(again)).toBe(canonical(report));
  });
});
