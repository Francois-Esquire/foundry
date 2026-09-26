import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import type { SurfaceReport } from "../../src/lib/types";

const root = path.join(import.meta.dirname, "fixtures", "deps");

let shared: SurfaceReport;
let satellite: SurfaceReport;
let logger: SurfaceReport;
let parent: SurfaceReport;

beforeAll(async () => {
  [shared, satellite, logger, parent] = await Promise.all([
    analyzeSurface({ root, target: "@deps/shared" }),
    analyzeSurface({ root, target: "@deps/satellite" }),
    analyzeSurface({ root, target: "@deps/logger" }),
    analyzeSurface({ root, target: "@deps/parent" }),
  ]);
});

function consumer(report: SurfaceReport, name: string) {
  const found = report.dependencies.incoming.find(
    (entry) => entry.package === name
  );
  if (!found) {
    throw new Error(`No consumer ${name}`);
  }
  return found;
}

describe("incoming dependencies", () => {
  it("counts a single consumer", () => {
    expect(satellite.dependencies.consumerPackages).toBe(1);
    expect(satellite.dependencies.incoming[0]?.package).toBe("@deps/parent");
  });

  it("counts several consumers with their distribution", () => {
    expect(shared.dependencies.consumerPackages).toBe(4);
    expect(shared.dependencies.incoming.map((entry) => entry.package)).toEqual([
      "@deps/parent",
      "@deps/alpha",
      "@deps/beta",
      "@deps/gamma",
    ]);
  });

  it("measures reference concentration", () => {
    expect(logger.dependencies.primaryConsumer?.package).toBe("@deps/parent");
    expect(logger.dependencies.primaryConsumer?.referenceShare).toBeCloseTo(
      5 / 6
    );
  });

  it("measures surface concentration per consumer", () => {
    expect(consumer(shared, "@deps/parent").surfaceShare).toBeCloseTo(3 / 5);
    expect(consumer(shared, "@deps/alpha").surfaceShare).toBeCloseTo(1 / 5);
    expect(consumer(shared, "@deps/beta").surfaceShare).toBeCloseTo(1 / 5);
  });

  it("classifies a type-only consumer", () => {
    expect(consumer(shared, "@deps/beta").usageNamespace).toBe("type");
  });

  it("classifies a runtime consumer", () => {
    expect(consumer(shared, "@deps/alpha").usageNamespace).toBe("value");
    expect(consumer(shared, "@deps/gamma").usageNamespace).toBe("value");
  });

  it("classifies a mixed consumer", () => {
    expect(consumer(shared, "@deps/parent").usageNamespace).toBe("both");
  });

  it("attributes edges to the symbols responsible for them", () => {
    const fromParent = consumer(shared, "@deps/parent");
    expect(fromParent.symbolsUsed).toBe(3);
    expect(fromParent.symbols.map((symbol) => symbol.symbolName)).toEqual([
      "SharedConfig",
      "sharedInit",
      "sharedRun",
    ]);
    const sharedRun = consumer(shared, "@deps/alpha").symbols[0];
    expect(sharedRun).toMatchObject({
      references: 2,
      symbolName: "sharedRun",
      usageContexts: { call: 2 },
      usageNamespace: "value",
    });
  });

  it("retains module-level evidence", () => {
    // parent imports shared both `import type` and by value: one edge, not type-only
    expect(consumer(shared, "@deps/parent").moduleEdges).toEqual([
      {
        fromFile: "packages/parent/src/index.ts",
        toFile: "packages/shared/src/index.ts",
        typeOnly: false,
      },
    ]);
    expect(
      consumer(shared, "@deps/beta").moduleEdges.map((edge) => edge.typeOnly)
    ).toEqual([true]);
  });

  it("computes average symbol distribution", () => {
    expect(shared.dependencies.averageSymbolDistribution).toBeCloseTo(6 / 5);
  });
});

describe("outgoing dependencies", () => {
  it("counts internal fan-out with module edges", () => {
    expect(parent.dependencies.dependencyPackages).toBe(6);
    expect(parent.dependencies.outgoing.map((entry) => entry.package)).toEqual([
      "@deps/alpha",
      "@deps/beta",
      "@deps/gamma",
      "@deps/logger",
      "@deps/satellite",
      "@deps/shared",
    ]);
    expect(
      parent.dependencies.outgoing.every((entry) => entry.moduleEdges === 1)
    ).toBe(true);
  });

  it("reports leaf packages with no outgoing dependencies", () => {
    expect(satellite.dependencies.dependencyPackages).toBe(0);
    expect(shared.dependencies.outgoing).toEqual([]);
  });
});

describe("shape signals", () => {
  it("marks a one-way satellite", () => {
    expect(satellite.dependencies.shapeSignals).toEqual([
      "single-consumer",
      "concentrated-consumption",
      "one-way-satellite",
    ]);
  });

  it("marks concentrated consumption without a satellite shape", () => {
    expect(logger.dependencies.shapeSignals).toEqual([
      "concentrated-consumption",
    ]);
  });

  it("marks a distributed shared hub", () => {
    expect(shared.dependencies.shapeSignals).toEqual([
      "distributed-consumption",
      "high-fan-in",
      "shared-hub",
    ]);
    expect(shared.dependencies.primaryConsumer?.referenceShare).toBeCloseTo(
      3 / 8
    );
  });

  it("marks high fan-out without inventing consumers", () => {
    expect(parent.dependencies.shapeSignals).toEqual(["high-fan-out"]);
    expect(parent.dependencies.consumerPackages).toBe(0);
    expect(parent.dependencies.primaryConsumer).toBeUndefined();
  });
});
