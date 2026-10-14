import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { buildSurfaceView } from "../../src/lib/render/reports/surface";
import type { BlockView } from "../../src/lib/render/views";
import type {
  FileHotspot,
  StructuralPressureSignal,
  SurfaceReport,
} from "../../src/lib/types";

/**
 * Fixtures are too small to fire pressure or history signals, so this test
 * grafts hand-built signals onto a real report and checks the sentences.
 */
let report: SurfaceReport;

beforeAll(async () => {
  const base = await analyzeSurface({
    now: new Date("2027-01-01T00:00:00Z"),
    root: join(import.meta.dirname, "fixtures", "workspace"),
    target: "packages/orders",
    tsconfig: "tsconfig.json",
  });
  if (
    !(
      base.hotspots.available &&
      base.changeCoupling.available &&
      base.evolutionaryPressure.available
    )
  ) {
    throw new Error("fixture must run inside a git repository");
  }
  const centralization: StructuralPressureSignal = {
    dimensions: ["gravity", "boundary"],
    evidence: [
      { dimension: "gravity", metric: "fanIn", value: 4 },
      { dimension: "boundary", metric: "incomingPackages", value: 4 },
      { dimension: "boundary", metric: "incomingReferences", value: 246 },
      {
        dimension: "boundary",
        metric: "destinationModule",
        value: "packages/orders/src/manager.ts",
      },
      {
        dimension: "boundary",
        metric: "destinationConcentration",
        value: 0.553,
      },
    ],
    id: "centralization-pressure:@repo/orders",
    intent: { anchored: false },
    kind: "centralization-pressure",
    scope: { id: "@repo/orders", type: "package" },
  };
  const hotspot: FileHotspot = {
    complexity: {
      controlFlowDecisions: { max: 4, total: 8 },
      expressionDecisions: { max: 0, total: 0 },
      functions: 4,
      nesting: { max: 3 },
      statements: { max: 9, total: 20 },
    },
    evolution: {
      additions: 10,
      commitPercentile: 0.99,
      commits: 38,
      deletions: 5,
      lineChurnPercentile: 0.9,
      linesChanged: 15,
    },
    file: "packages/orders/src/manager.ts",
    kind: "source",
    rank: {
      commitPercentile: 0.99,
      complexityPercentile: 0.8,
      lineChurnPercentile: 0.9,
    },
    signals: ["frequent-change", "branch-heavy"],
  };
  report = {
    ...base,
    changeCoupling: {
      ...base.changeCoupling,
      summary: {
        ...base.changeCoupling.summary,
        filePairs: 64,
        filePairsWithoutStaticEdge: 33,
      },
    },
    evolutionaryPressure: {
      ...base.evolutionaryPressure,
      reinforced: [
        {
          evolutionaryEvidence: [],
          intent: { anchored: false },
          kind: "reinforced-centralization-pressure",
          staticEvidence: [],
          staticSignal: "centralization-pressure",
          support: { commits: 52 },
        },
      ],
      tensions: [1, 2].map((n) => ({
        evidence: { evolutionary: [], static: [] },
        kind: "temporal-coupling-without-static-path",
        summary: `a${n}.ts and b${n}.ts change together without any static path between them.`,
        support: { commits: 52 },
      })),
    },
    hotspots: {
      ...base.hotspots,
      files: [hotspot],
      summary: {
        ...base.hotspots.summary,
        eligibleSourceFiles: 42,
        hotspots: 3,
      },
    },
    structuralPressure: {
      boundaries: [
        {
          evidence: [
            { dimension: "boundary", metric: "references", value: 191 },
            { dimension: "boundary", metric: "symbols", value: 23 },
            {
              dimension: "boundary",
              metric: "topDestinationModule",
              value: "packages/orders/src/manager.ts",
            },
            {
              dimension: "boundary",
              metric: "destinationConcentration",
              value: 0.596,
            },
          ],
          from: "@repo/checkout",
          shape: "concentrated",
          to: "@repo/orders",
        },
      ],
      signals: [centralization],
      target: base.structuralPressure.target,
    },
  };
});

function signals(density: "compact" | "normal" | "expanded"): BlockView[] {
  const section = buildSurfaceView(
    report,
    ANALYSIS_CONFIG,
    density
  ).sections.find((item) => item.title === "SIGNALS");
  return section?.blocks.filter((block) => block.kind === "signal") ?? [];
}

describe("signal groups", () => {
  it("compose one sentence per measurement family", () => {
    const [consumption, gravity] = signals("normal");
    expect(consumption).toMatchObject({
      summary:
        "@repo/checkout holds 57.1% of external references across 3 consumer packages; each used symbol reaches 1.29 of them on average.",
      title: "broadly-consumed",
    });
    expect(gravity).toMatchObject({
      summary:
        "3 packages depend on this one and it depends on 0; changes here reach 100.0% of workspace packages.",
      title: "foundation-like",
    });
  });

  it("state pressure facts from the signal's own evidence", () => {
    const [, , pressure] = signals("normal");
    expect(pressure).toMatchObject({
      evidence: [
        "centralization-pressure: 246 references from 4 packages, 55.3% landing in packages/orders/src/manager.ts",
        "boundary-pressure: from @repo/checkout into @repo/orders, 191 references over 23 symbols, 59.6% into packages/orders/src/manager.ts (concentrated)",
      ],
      title: "centralization-pressure · boundary-pressure",
    });
  });

  it("promote history facts analysis already gated, grouping tensions by kind", () => {
    const [, , , history] = signals("normal");
    expect(history).toMatchObject({
      evidence: [
        "hotspots: 3 source files of 42 change often and carry complexity; highest packages/orders/src/manager.ts (38 commits)",
        "change-coupling: 33 of 64 strong file pairs have no static dependency between them",
        "reinforced-centralization-pressure: history reinforces centralization-pressure over 52 commits",
        "temporal-coupling-without-static-path (2): a1.ts and b1.ts change together without any static path between them.",
      ],
      title:
        "hotspots · change-coupling · reinforced-centralization-pressure · temporal-coupling-without-static-path",
    });
  });

  it("keep titles only at compact and add raw metrics at expanded", () => {
    for (const block of signals("compact")) {
      expect(block).not.toHaveProperty("summary");
      expect(block).not.toHaveProperty("evidence");
    }
    const [, , pressure] = signals("expanded");
    expect(pressure?.kind === "signal" && pressure.evidence?.at(-1)).toBe(
      "boundary-pressure @repo/checkout into @repo/orders: references 191 · symbols 23 · top destination module packages/orders/src/manager.ts · destination concentration 59.6%"
    );
  });
});
