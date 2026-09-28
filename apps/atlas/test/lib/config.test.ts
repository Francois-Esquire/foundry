import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { resolveBoundary } from "../../src/lib/boundary";
import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { buildOpportunities } from "../../src/lib/opportunities";
import { renderReport } from "../../src/lib/report";
import type { SurfaceReport } from "../../src/lib/types";

const root = join(import.meta.dirname, "fixtures", "deps");

let logger: SurfaceReport;
let shared: SurfaceReport;

beforeAll(async () => {
  [logger, shared] = await Promise.all([
    analyzeSurface({ root, target: "@deps/logger" }),
    analyzeSurface({ root, target: "@deps/shared" }),
  ]);
});

function tuned(mutate: (config: AnalysisConfig) => void): AnalysisConfig {
  const config = structuredClone(ANALYSIS_CONFIG);
  mutate(config);
  return config;
}

describe("config injection", () => {
  it("fold eligibility follows the injected consumer gate", () => {
    const boundary = resolveBoundary(root, "@deps/logger");
    const withDefaults = buildOpportunities(
      boundary,
      logger.symbols,
      logger.dependencies
    );
    expect(
      withDefaults.opportunities.some(
        (entry) => entry.operation === "fold-package"
      )
    ).toBe(false);

    // Proves only that the gate reads config: with the gate widened to two
    // consumers, the single-consumer evidence semantics no longer generalize.
    const widened = buildOpportunities(
      boundary,
      logger.symbols,
      logger.dependencies,
      tuned((config) => {
        config.opportunities.foldPackage.gates.requiredConsumers = 2;
      })
    );
    const fold = widened.opportunities.find(
      (entry) => entry.operation === "fold-package"
    );
    expect(fold?.target?.name).toBe("@deps/parent");
  });

  it("preserve eligibility follows the injected gates", () => {
    const boundary = resolveBoundary(root, "@deps/logger");
    const widened = buildOpportunities(
      boundary,
      logger.symbols,
      logger.dependencies,
      tuned((config) => {
        config.opportunities.preserveSharedBoundary.gates.minConsumers = 2;
        config.opportunities.preserveSharedBoundary.gates.maxPrimaryReferenceShare = 0.9;
      })
    );
    expect(
      widened.opportunities.some(
        (entry) => entry.operation === "preserve-shared-boundary"
      )
    ).toBe(true);
    expect(
      widened.ineligibleOperations.map((entry) => entry.operation)
    ).toEqual(["fold-package"]);
  });

  it("report display caps follow the injected config", () => {
    const rendered = renderReport(
      shared,
      tuned((config) => {
        config.report.symbolsPerConsumer = 1;
      })
    );
    expect(rendered).toContain("… 2 more symbols");
  });
});
