import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import {
  applyReductionPlan,
  verifyInternalizeExport,
} from "../../src/lib/apply";
import type { AnalysisConfig } from "../../src/lib/config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { getOperator, listOperators } from "../../src/lib/operators";
import { renderMutation, renderReport } from "../../src/lib/report";
import type {
  InternalizeSymbolPlan,
  ReductionPlan,
  SurfaceReport,
} from "../../src/lib/types";
import { validateReductionPlan } from "../../src/lib/validate";

const fixtureRoot = path.join(import.meta.dirname, "fixtures", "deps");

const tempRoots: string[] = [];

function tempFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-surface-op-"));
  tempRoots.push(dir);
  fs.cpSync(fixtureRoot, dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=test",
    "commit",
    "-qm",
    "fixture"
  );
  return dir;
}

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir })
    .toString()
    .trim();
}

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

const anchoredConfig: AnalysisConfig = {
  ...ANALYSIS_CONFIG,
  anchors: [
    { reason: "Intentional subsystem boundary", target: "@deps/satellite" },
  ],
};

function internalizePlan(
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

function foldPlan(report: SurfaceReport): ReductionPlan {
  const plan = report.plans.find((entry) => entry.operation === "fold-package");
  if (!plan) {
    throw new Error("No fold plan in report");
  }
  return plan;
}

describe("anchors", () => {
  it("still analyzes an anchored package completely", async () => {
    const report = await analyzeSurface({
      config: anchoredConfig,
      root: fixtureRoot,
      target: "@deps/satellite",
    });
    expect(report.anchor).toEqual({
      reason: "Intentional subsystem boundary",
      target: "@deps/satellite",
    });
    expect(report.symbols.length).toBeGreaterThan(0);
    expect(report.dependencies.consumerPackages).toBe(1);
    expect(
      report.opportunities.some((entry) => entry.operation === "fold-package")
    ).toBe(true);
    expect(renderReport(report)).toContain("ANCHOR");
  });

  it("blocks the fold plan for an anchored source package", async () => {
    const report = await analyzeSurface({
      config: anchoredConfig,
      root: fixtureRoot,
      target: "@deps/satellite",
    });
    const plan = foldPlan(report);
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.map((blocker) => blocker.reason)).toContain(
      "anchored-boundary"
    );
  });

  it("leaves internalization plans unaffected by a package anchor", async () => {
    const report = await analyzeSurface({
      config: anchoredConfig,
      root: fixtureRoot,
      target: "@deps/satellite",
    });
    const ready = report.plans.filter(
      (plan) =>
        plan.operation === "internalize-symbol" && plan.status === "ready"
    );
    expect(ready.length).toBe(1);
  });
});

describe("operator registry", () => {
  it("registers both operators with distinct capabilities", () => {
    expect(listOperators().map((operator) => operator.id)).toEqual([
      "internalize-export",
      "fold-package",
    ]);
    expect(getOperator("internalize-export").capabilities).toEqual({
      apply: true,
      plan: true,
      validate: true,
      verify: true,
    });
    expect(getOperator("fold-package").capabilities).toEqual({
      apply: false,
      plan: true,
      validate: true,
      verify: false,
    });
    expect(() => getOperator("delete-symbol")).toThrow("Unknown operator");
  });
});

describe("analyze mode", () => {
  it("runs the whole pipeline without modifying any file", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    expect(report.plans.length).toBeGreaterThan(0);
    const summary = report.operators.find(
      (operator) => operator.id === "internalize-export"
    );
    expect(summary?.opportunities).toBeGreaterThan(0);
    expect(summary?.plans.ready).toBeGreaterThan(0);
    const rendered = renderReport(report);
    expect(rendered).toContain("OPERATORS");
    expect(rendered).toContain("mutation supported");
    expect(rendered).toContain("mutation unsupported");
    expect(rendered).toContain("MODE");
    expect(rendered).toContain("ANALYZE");
    expect(gitStatus(root)).toBe("");
  });
});

describe("plan validation", () => {
  it("validates a fresh internalize plan as ready", async () => {
    const report = await analyzeSurface({
      root: fixtureRoot,
      target: "@deps/plans",
    });
    const plan = internalizePlan(report, "PlanAlpha");
    const validation = validateReductionPlan(plan, report);
    expect(validation.status).toBe("ready");
    expect(validation.preconditions.every((entry) => entry.holds)).toBe(true);
    expect(validation.currentFingerprint).toBe(plan.fingerprint);
  });

  it("validates a fresh fold plan as ready", async () => {
    const report = await analyzeSurface({
      root: fixtureRoot,
      target: "@deps/satellite",
    });
    const validation = validateReductionPlan(foldPlan(report), report);
    expect(validation.status).toBe("ready");
  });

  it("detects a stale internalize plan after a consumer appears", async () => {
    const root = tempFixture();
    const before = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(before, "PlanAlpha");
    fs.writeFileSync(
      path.join(root, "packages/parent/src/uses-plans.ts"),
      'import type { PlanAlpha } from "@deps/plans";\n\nexport type PlanAlphaAlias = PlanAlpha;\n'
    );
    const after = await analyzeSurface({ root, target: "@deps/plans" });
    const validation = validateReductionPlan(plan, after);
    expect(validation.status).toBe("stale");
    expect(
      validation.preconditions.some(
        (entry) => entry.fact === "external references" && !entry.holds
      )
    ).toBe(true);
  });

  it("detects a stale fold plan after a second consumer appears", async () => {
    const root = tempFixture();
    const before = await analyzeSurface({ root, target: "@deps/satellite" });
    const plan = foldPlan(before);
    fs.writeFileSync(
      path.join(root, "packages/contract/src/uses-satellite.ts"),
      'import { launchSatellite } from "@deps/satellite";\n\nexport const relaunch = () => launchSatellite();\n'
    );
    const after = await analyzeSurface({ root, target: "@deps/satellite" });
    const validation = validateReductionPlan(plan, after);
    expect(validation.status).toBe("stale");
    expect(
      validation.preconditions.some(
        (entry) => entry.fact === "single consumer gate" && !entry.holds
      )
    ).toBe(true);
  });
});

describe("preview", () => {
  it("previews a ready plan without writing", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanBeta");
    const mutation = await applyReductionPlan(plan, { root });
    expect(mutation.status).toBe("preview");
    expect(mutation.changedFiles).toEqual(["packages/plans/src/index.ts"]);
    expect(gitStatus(root)).toBe("");
    expect(renderMutation(mutation)).toContain("Use --write to apply");
  });
});

describe("apply internalize-export", () => {
  it("rewrites a shared named type re-export and verifies", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanBeta");
    const mutation = await applyReductionPlan(plan, { root, write: true });
    expect(mutation.status).toBe("applied");
    expect(mutation.verification?.status).toBe("pass");
    expect(mutation.observedDelta).toEqual({
      exportedSymbols: -1,
      externallyUsedSymbols: 0,
      totalSymbols: 0,
      unusedExternalExports: -1,
    });
    const index = fs.readFileSync(
      path.join(root, "packages/plans/src/index.ts"),
      "utf8"
    );
    expect(index).toContain("PlanBetaExtra");
    expect(index).not.toMatch(/PlanBeta[,\s}]/);
    // the module export and its internal consumer survive untouched
    const bar = fs.readFileSync(
      path.join(root, "packages/plans/src/bar.ts"),
      "utf8"
    );
    expect(bar).toContain("export interface PlanBeta");
    expect(
      fs.readFileSync(path.join(root, "packages/plans/src/internal.ts"), "utf8")
    ).toContain('from "./bar"');
  });

  it("removes the export modifier for a direct entrypoint declaration", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanDirect");
    const mutation = await applyReductionPlan(plan, { root, write: true });
    expect(mutation.status).toBe("applied");
    expect(mutation.verification?.status).toBe("pass");
    const index = fs.readFileSync(
      path.join(root, "packages/plans/src/index.ts"),
      "utf8"
    );
    expect(index).not.toContain("export interface PlanDirect {");
    expect(index).toContain("interface PlanDirect {");
  });

  it("removes every public route of a multi-entrypoint symbol", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans-multi" });
    const plan = internalizePlan(report, "PlanShared");
    expect(plan.publicRoutes.length).toBeGreaterThan(1);
    const mutation = await applyReductionPlan(plan, { root, write: true });
    expect(mutation.status).toBe("applied");
    expect(mutation.changedFiles.length).toBeGreaterThan(1);
    expect(mutation.verification?.status).toBe("pass");
  });

  it("refuses to apply an unsupported star-export plan", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans-star" });
    const plan = internalizePlan(report, "PlanHidden");
    expect(plan.status).toBe("unsupported");
    const mutation = await applyReductionPlan(plan, { root, write: true });
    expect(mutation.status).toBe("unsupported");
    expect(gitStatus(root)).toBe("");
  });

  it("blocks when a planned file has uncommitted changes", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanAlpha");
    const index = path.join(root, "packages/plans/src/index.ts");
    fs.appendFileSync(index, "// local edit\n");
    const mutation = await applyReductionPlan(plan, { root, write: true });
    expect(mutation.status).toBe("blocked");
    expect(mutation.blockers?.map((blocker) => blocker.reason)).toContain(
      "dirty-working-tree"
    );
    expect(fs.readFileSync(index, "utf8")).toContain("// local edit");
  });

  it("rolls back byte-for-byte when verification fails", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanAlpha");
    const index = path.join(root, "packages/plans/src/index.ts");
    const original = fs.readFileSync(index, "utf8");
    // the fingerprint covers input facts, not the derived delta — a wrong
    // prediction passes validation and must be caught by verification
    const lying: InternalizeSymbolPlan = {
      ...plan,
      predictedDelta: { ...plan.predictedDelta, unusedExternalExports: -2 },
    };
    const mutation = await applyReductionPlan(lying, { root, write: true });
    expect(mutation.status).toBe("rolled-back");
    expect(mutation.verification?.status).toBe("fail");
    expect(fs.readFileSync(index, "utf8")).toBe(original);
    expect(gitStatus(root)).toBe("");
    const rendered = renderMutation(mutation);
    expect(rendered).toContain("VERIFICATION FAILED");
    expect(rendered).toContain("ROLLBACK COMPLETE");
  });
});

describe("structural verification", () => {
  it("fails when a public route survives even though TypeScript would pass", async () => {
    const report = await analyzeSurface({
      root: fixtureRoot,
      target: "@deps/plans",
    });
    const plan = internalizePlan(report, "PlanAlpha");
    // "after" identical to "before": the route is still there
    const verification = verifyInternalizeExport(plan, report, report);
    expect(verification.status).toBe("fail");
    const publicCheck = verification.checks.find(
      (check) => check.check === "symbol no longer package-public"
    );
    expect(publicCheck?.status).toBe("fail");
    expect(publicCheck?.detail).toContain("@deps/plans");
  });
});

describe("fold apply", () => {
  it("reports fold-package mutation as unsupported and touches nothing", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/satellite" });
    const mutation = await applyReductionPlan(foldPlan(report), {
      root,
      write: true,
    });
    expect(mutation.status).toBe("unsupported");
    expect(mutation.changedFiles).toEqual([]);
    expect(mutation.blockers?.[0]?.detail).toContain("not implemented");
    expect(gitStatus(root)).toBe("");
  });
});
