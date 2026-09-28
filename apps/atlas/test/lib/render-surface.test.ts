import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type { RenderOptions } from "../../src/lib/render";
import { DEFAULT_CONTEXT, renderSurface } from "../../src/lib/render";
import { createTextRenderer } from "../../src/lib/render/text";
import type { ReportView } from "../../src/lib/render/views";
import type { SurfaceReport } from "../../src/lib/types";

const fixtures = mkdtempSync(join(tmpdir(), "atlas-render-"));
cpSync(join(import.meta.dirname, "fixtures"), fixtures, {
  recursive: true,
});
afterAll(() => rmSync(fixtures, { force: true, recursive: true }));
/**
 * Churn recency is measured against a clock; pin it so runs compare equal.
 * Commit counts still move whenever fixture files are committed, so a churn
 * line changing in a snapshot after a fixture edit is expected, not a defect.
 */
const now = new Date("2027-01-01T00:00:00Z");

const anchored: AnalysisConfig = {
  ...ANALYSIS_CONFIG,
  anchors: [
    { reason: "Intentional subsystem boundary", target: "@deps/satellite" },
  ],
};

interface Case {
  config?: AnalysisConfig;
  name: string;
  root: string;
  target: string;
  tsconfig?: string;
}

const cases: Case[] = [
  {
    name: "package with consumers",
    root: "workspace",
    target: "packages/orders",
    tsconfig: "tsconfig.json",
  },
  { name: "fold candidate", root: "deps", target: "@deps/satellite" },
  {
    config: anchored,
    name: "anchored fold candidate",
    root: "deps",
    target: "@deps/satellite",
  },
  { name: "shared boundary", root: "deps", target: "@deps/shared" },
  { name: "zero consumers", root: "deps", target: "@deps/leaf-user" },
  { name: "hub", root: "traffic", target: "@traffic/hub" },
];

const reports = new Map<string, SurfaceReport>();

/**
 * Fixtures live inside this repository, so their Git-derived sections change
 * whenever anyone commits a fixture edit. Only the first case keeps real
 * history, to cover the available branches; the rest render as if outside Git.
 */
function withoutHistory(report: SurfaceReport): SurfaceReport {
  const unavailable = {
    available: false,
    reason: "not-git-repository",
  } as const;
  return {
    ...report,
    changeCoupling: unavailable,
    changeRadius: unavailable,
    churn: unavailable,
    evolutionaryPressure: unavailable,
    hotspots: unavailable,
  };
}

beforeAll(async () => {
  await Promise.all(
    cases.map(async (item, index) => {
      const report = await analyzeSurface({
        root: join(fixtures, item.root),
        target: item.target,
        ...(item.tsconfig !== undefined && { tsconfig: item.tsconfig }),
        ...(item.config !== undefined && { config: item.config }),
        now,
      });
      reports.set(item.name, index === 0 ? report : withoutHistory(report));
    })
  );
});

function render(item: Case, options: RenderOptions = {}): string {
  const report = reports.get(item.name);
  if (report === undefined) {
    throw new Error(`no report for ${item.name}`);
  }
  return renderSurface(report, {
    config: item.config ?? ANALYSIS_CONFIG,
    ...options,
  });
}

describe("surface report", () => {
  for (const item of cases) {
    it(`${item.name}: text`, () => {
      expect(render(item)).toMatchSnapshot();
    });
  }

  const [first] = cases;
  if (first === undefined) {
    throw new Error("no cases");
  }
  const [, , anchoredCase] = cases;
  if (anchoredCase === undefined) {
    throw new Error("no anchored case");
  }

  it("terminal, wide, unicode", () => {
    expect(render(first, { format: "terminal", width: 120 })).toMatchSnapshot();
  });

  it("terminal, narrow, ascii", () => {
    expect(
      render(anchoredCase, { format: "terminal", unicode: false, width: 60 })
    ).toMatchSnapshot();
  });

  it("compact density", () => {
    expect(render(anchoredCase, { density: "compact" })).toMatchSnapshot();
  });

  it("expanded density", () => {
    expect(render(first, { density: "expanded" })).toMatchSnapshot();
  });

  it("markdown", () => {
    expect(render(anchoredCase, { format: "markdown" })).toMatchSnapshot();
  });

  it("never emits ANSI when color is off", () => {
    expect(render(first, { format: "terminal" })).not.toContain(
      String.fromCharCode(27)
    );
  });
});

describe("text renderer", () => {
  const view: ReportView = {
    sections: [
      {
        blocks: [
          {
            kind: "labelValue",
            rows: [
              { label: "Target", value: "x" },
              { label: "Path", value: "y" },
            ],
          },
        ],
      },
      {
        blocks: [
          {
            items: [
              { label: "Long label", value: 0.5 },
              { label: "Short", value: 1 },
            ],
            kind: "ratio",
          },
          { kind: "text", lines: ["", "trailing"] },
        ],
        title: "RATIOS",
      },
    ],
    title: "TITLE",
  };

  it("aligns values past the widest label and indents titled sections", () => {
    expect(createTextRenderer(DEFAULT_CONTEXT).report(view)).toBe(
      [
        "TITLE",
        "═════",
        "Target  x",
        "Path    y",
        "",
        "RATIOS",
        "  Long label   50.0%",
        "  Short       100.0%",
        "",
        "  trailing",
      ].join("\n")
    );
  });

  it("falls back to an ASCII rule without unicode", () => {
    const rendered = createTextRenderer({
      ...DEFAULT_CONTEXT,
      unicode: false,
    }).report(view);
    expect(rendered.split("\n")[1]).toBe("=====");
  });
});
