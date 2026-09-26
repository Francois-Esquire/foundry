import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import {
  renderComplexity,
  renderFunctionComplexity,
  renderReport,
} from "../../src/lib/report";
import type { FunctionComplexity, SurfaceReport } from "../../src/lib/types";

const root = path.join(import.meta.dirname, "fixtures", "deps");

let report: SurfaceReport;

beforeAll(async () => {
  report = await analyzeSurface({ root, target: "@deps/complexity" });
});

function fn(
  name: string,
  kind?: FunctionComplexity["kind"]
): FunctionComplexity {
  const match = report.localComplexity.functions.find(
    (entry) =>
      entry.name === name && (kind === undefined || entry.kind === kind)
  );
  if (!match) {
    throw new Error(`function not found: ${name}`);
  }
  return match;
}

describe("function shapes", () => {
  it("measures a flat function", () => {
    const flat = fn("flat");
    expect(flat.kind).toBe("function");
    expect(flat.metrics.decisions.total).toBe(0);
    expect(flat.metrics.nesting.max).toBe(0);
    expect(flat.metrics.parameters.total).toBe(1);
    expect(flat.metrics.exits.returns).toBe(1);
    expect(flat.metrics.statements).toBe(1);
  });

  it("measures nested branches", () => {
    const nested = fn("nested");
    expect(nested.metrics.decisions).toMatchObject({
      controlFlow: 2,
      expression: 0,
      ifs: 2,
      total: 2,
    });
    expect(nested.metrics.nesting.max).toBe(2);
    expect(nested.metrics.exits.returns).toBe(2);
    expect(nested.metrics.parameters.boolean).toBe(2);
  });

  it("keeps guard clauses many-decision but shallow", () => {
    const guarded = fn("guarded");
    expect(guarded.metrics.decisions.total).toBe(3);
    expect(guarded.metrics.nesting.max).toBe(1);
    expect(guarded.metrics.exits.returns).toBe(3);
    expect(guarded.metrics.parameters.optional).toBe(1);
  });

  it("counts else-if as a decision without deepening nesting", () => {
    const ladder = fn("ladder");
    expect(ladder.metrics.decisions).toMatchObject({
      elseIfs: 2,
      ifs: 1,
      total: 3,
    });
    expect(ladder.metrics.nesting.max).toBe(1);
  });

  it("measures deep nesting through if/loop/try", () => {
    const deep = fn("deep");
    expect(deep.metrics.nesting.max).toBe(6);
    expect(deep.metrics.decisions).toMatchObject({
      catches: 1,
      controlFlow: 6,
      expression: 0,
      ifs: 3,
      loops: 2,
      total: 6,
    });
    expect(deep.metrics.loops).toMatchObject({ forOf: 2, total: 2 });
    expect(deep.metrics.exceptions).toMatchObject({
      catches: 1,
      finals: 0,
      tries: 1,
    });
    expect(deep.metrics.statements).toBe(9);
  });

  it("counts switch cases as decisions, not the switch or default", () => {
    const pick = fn("pick");
    expect(pick.metrics.decisions).toMatchObject({
      cases: 3,
      defaults: 1,
      switches: 1,
      total: 3,
    });
    expect(pick.metrics.exits.returns).toBe(4);
  });

  it("counts ternaries and short-circuit operators, not nullish coalescing", () => {
    const logic = fn("ternaryLogic");
    expect(logic.metrics.decisions).toMatchObject({
      controlFlow: 0,
      expression: 4,
      logical: 2,
      ternaries: 2,
      total: 4,
    });
  });

  it("counts nullish coalescing when configured", async () => {
    const config = structuredClone(
      (await import("../../src/lib/config")).ANALYSIS_CONFIG
    );
    config.localComplexity.decisions.countNullishCoalescing = true;
    const tuned = await analyzeSurface({
      config,
      root,
      target: "@deps/complexity",
    });
    const logic = tuned.localComplexity.functions.find(
      (entry) => entry.name === "ternaryLogic"
    );
    expect(logic?.metrics.decisions.logical).toBe(3);
    expect(logic?.metrics.decisions.expression).toBe(5);
    expect(logic?.metrics.decisions.total).toBe(5);
  });

  it("splits mixed statement- and expression-level branching", () => {
    const flags = fn("flags");
    expect(flags.metrics.decisions).toMatchObject({
      controlFlow: 2,
      expression: 2,
      ifs: 2,
      logical: 1,
      ternaries: 1,
      total: 4,
    });
  });

  it("records async and generator shape", () => {
    const fetchTwice = fn("fetchTwice");
    expect(fetchTwice.metrics.async).toEqual({
      async: true,
      awaits: 2,
      generator: false,
      yields: 0,
    });
    const counter = fn("counter");
    expect(counter.metrics.async).toMatchObject({
      async: false,
      generator: true,
      yields: 1,
    });
    expect(counter.metrics.loops.for).toBe(1);
  });

  it("counts every explicit exit kind", () => {
    const exits = fn("exits");
    expect(exits.metrics.exits).toEqual({
      breaks: 1,
      continues: 1,
      returns: 1,
      throws: 1,
    });
  });
});

describe("callbacks and nesting separation", () => {
  it("tracks callback depth separately from control-flow nesting", () => {
    const mapFilter = fn("mapFilter");
    expect(mapFilter.metrics.callbacks).toEqual({
      maxDepth: 2,
      nestedFunctions: 2,
    });
    expect(mapFilter.metrics.nesting.max).toBe(0);
    expect(mapFilter.metrics.decisions.total).toBe(0);
    expect(mapFilter.metrics.statements).toBe(1);
  });

  it("attributes an inner function's body to its own record", () => {
    const anonymous = report.localComplexity.functions.filter(
      (entry) => entry.name === "<anonymous>" && entry.kind === "arrow"
    );
    expect(anonymous.length).toBeGreaterThanOrEqual(4);
    const ids = anonymous.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a callback inside a method out of the method's statement count", () => {
    const drain = fn("drain");
    expect(drain.metrics.callbacks).toEqual({
      maxDepth: 1,
      nestedFunctions: 1,
    });
    expect(drain.metrics.statements).toBe(3);
    expect(drain.metrics.loops.while).toBe(1);
  });
});

describe("parameter classification", () => {
  it("classifies boolean parameters by type, never by name", () => {
    const flags = fn("flags");
    expect(flags.metrics.parameters).toEqual({
      boolean: 3,
      defaulted: 0,
      optional: 1,
      rest: 0,
      total: 5,
    });
  });

  it("resolves a boolean type alias through the checker", () => {
    expect(fn("aliased").metrics.parameters.boolean).toBe(1);
  });

  it("records defaulted and rest parameters", () => {
    expect(fn("varied").metrics.parameters).toEqual({
      boolean: 0,
      defaulted: 1,
      optional: 0,
      rest: 1,
      total: 3,
    });
  });
});

describe("ownership and identity", () => {
  it("associates functions with their surface symbols", () => {
    const flat = fn("flat");
    expect(flat.ownerSymbolId).toBe("packages/complexity/src/shapes.ts#flat");
    expect(flat.exported).toBe(true);
    expect(flat.packagePublic).toBe(true);
    const handle = fn("handle");
    expect(handle.exported).toBe(false);
    expect(handle.packagePublic).toBe(false);
  });

  it("gives class members the class's surface status", () => {
    const step = fn("step", "method");
    expect(step.ownerSymbolId).toBe(
      "packages/complexity/src/shapes.ts#Machine"
    );
    expect(step.exported).toBe(true);
    expect(step.packagePublic).toBe(true);
    expect(fn("constructor").kind).toBe("constructor");
    expect(fn("remaining").kind).toBe("getter");
    expect(fn("progress").kind).toBe("setter");
  });

  it("never marks nested or element functions as surface API", () => {
    for (const entry of report.localComplexity.functions) {
      if (entry.name !== "<anonymous>") {
        continue;
      }
      expect(entry.exported).toBe(false);
      expect(entry.packagePublic).toBe(false);
    }
  });
});

describe("aggregation", () => {
  it("analyzes every executable function once", () => {
    expect(report.localComplexity.summary.functionsAnalyzed).toBe(25);
    expect(report.localComplexity.functions).toHaveLength(25);
  });

  it("computes nearest-rank percentiles over the measured values", () => {
    const decisions = report.localComplexity.functions
      .map((entry) => entry.metrics.decisions.total)
      .sort((a, b) => a - b);
    const rank = (q: number) =>
      decisions[Math.max(0, Math.ceil(q * decisions.length) - 1)];
    const { distribution } = report.localComplexity.summary.decisions;
    expect(distribution.p50).toBe(rank(0.5));
    expect(distribution.p90).toBe(rank(0.9));
    expect(distribution.p95).toBe(rank(0.95));
    expect(distribution.max).toBe(6);
    expect(report.localComplexity.summary.nesting.distribution.max).toBe(6);
    expect(report.localComplexity.summary.parameters.distribution.max).toBe(5);
    expect(report.localComplexity.summary.statements.distribution.max).toBe(9);
  });

  it("keeps total equal to controlFlow + expression for every function", () => {
    for (const entry of report.localComplexity.functions) {
      const {
        total,
        controlFlow,
        expression,
        ifs,
        elseIfs,
        cases,
        loops,
        catches,
        ternaries,
        logical,
      } = entry.metrics.decisions;
      expect(total).toBe(controlFlow + expression);
      expect(controlFlow).toBe(ifs + elseIfs + cases + loops + catches);
      expect(expression).toBe(ternaries + logical);
    }
  });

  it("keeps totals and averages consistent", () => {
    const { statements } = report.localComplexity.summary;
    const total = report.localComplexity.functions.reduce(
      (sum, entry) => sum + entry.metrics.statements,
      0
    );
    expect(statements.total).toBe(total);
    expect(statements.average).toBeCloseTo(total / 25);
  });
});

describe("rendering", () => {
  it("adds a compact section to the default report", () => {
    const rendered = renderReport(report);
    expect(rendered).toContain("LOCAL COMPLEXITY");
    expect(rendered).toContain("25 functions analyzed");
    expect(rendered).toMatch(
      /Decisions {3}p50 \d+ · p90 \d+ · p95 \d+ · max 6/
    );
  });

  it("renders the focused complexity view", () => {
    const rendered = renderComplexity(report);
    expect(rendered).toContain("MOST DECISIONS");
    expect(rendered).toContain("DEEPEST NESTING");
    expect(rendered).toContain("MOST PARAMETERS");
    expect(rendered).toContain("LARGEST FUNCTIONS");
    expect(rendered).toContain("deep");
    expect(rendered).toContain(
      "6 decisions (6 control flow · 0 expression) · nesting 6"
    );
  });

  it("renders one function's full metric vector", () => {
    const rendered = renderFunctionComplexity(fn("deep"));
    expect(rendered).toContain("kind      function");
    expect(rendered).toContain("surface   module exported · package public");
    expect(rendered).toContain("control flow  6");
    expect(rendered).toContain("expression    0");
    expect(rendered).toContain("NESTING     max 6");
    expect(rendered).toContain("STATEMENTS  9");
  });
});
