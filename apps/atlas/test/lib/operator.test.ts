import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import {
  applyReductionPlan,
  restoreWritten,
  sha256,
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

const expectedTextPattern = /PlanBeta[,\s}]/;

const fixtureRoot = join(import.meta.dirname, "fixtures", "deps");

const tempRoots: string[] = [];

/** A copy of the deps fixture; committed to a fresh repository unless `git` is false. */
function tempFixture(
  { git: inRepository = true }: { git?: boolean } = {},
  prepare: (dir: string) => void = () => undefined
): string {
  const dir = mkdtempSync(join(tmpdir(), "semantic-surface-op-"));
  tempRoots.push(dir);
  cpSync(fixtureRoot, dir, { recursive: true });
  prepare(dir);
  if (!inRepository) {
    return dir;
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture"
  );
  return dir;
}

const INDEX = "packages/plans/src/index.ts";

/** A write journals nothing in these tests; `atlas apply` passes the real journal. */
const noJournal = () => Promise.resolve();

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir })
    .toString()
    .trim();
}

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
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
    writeFileSync(
      join(root, "packages/parent/src/uses-plans.ts"),
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
    writeFileSync(
      join(root, "packages/contract/src/uses-satellite.ts"),
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

  it("says how each edited statement reads before and after, a declaration by its first line", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const shared = await applyReductionPlan(
      internalizePlan(report, "PlanBeta"),
      {
        root,
      }
    );
    expect(shared.edits).toEqual([
      {
        after: 'export type { PlanBetaExtra } from "./bar";',
        before: 'export type { PlanBeta, PlanBetaExtra } from "./bar";',
        file: INDEX,
      },
    ]);
    const direct = await applyReductionPlan(
      internalizePlan(report, "PlanDirect"),
      { root }
    );
    expect(direct.edits).toEqual([
      {
        after: "interface PlanDirect {",
        before: "export interface PlanDirect {",
        file: INDEX,
      },
    ]);
    const alone = await applyReductionPlan(
      internalizePlan(report, "PlanAlpha"),
      { root }
    );
    expect(alone.edits).toEqual([
      {
        after: null,
        before: 'export type { PlanAlpha } from "./foo";',
        file: INDEX,
      },
    ]);
    expect(gitStatus(root)).toBe("");
  });

  it("names a decorated declaration by its header, not its decorator", async () => {
    const root = tempFixture({}, (dir) => {
      appendFileSync(
        join(dir, INDEX),
        "\nfunction sealed(target: unknown): void {\n  Object.seal(target);\n}\n\n@sealed\nexport class Decorated {}\n"
      );
    });
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const mutation = await applyReductionPlan(
      internalizePlan(report, "Decorated"),
      { root }
    );
    expect(mutation.edits).toEqual([
      {
        after: "class Decorated {}",
        before: "export class Decorated {}",
        file: INDEX,
      },
    ]);
  });

  it("previews without Git, but refuses to write, saying why", async () => {
    const root = tempFixture({ git: false });
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanAlpha");
    expect((await applyReductionPlan(plan, { root })).status).toBe("preview");
    const original = readFileSync(join(root, INDEX));
    const mutation = await applyReductionPlan(plan, {
      beforeWrite: noJournal,
      root,
      write: true,
    });
    expect(mutation.status).toBe("blocked");
    expect(mutation.blockers).toEqual([
      {
        detail:
          "The workspace is not in a Git repository, so Atlas cannot tell whether a planned file has uncommitted changes. Write only in a repository.",
        reason: "no-git",
      },
    ]);
    expect(readFileSync(join(root, INDEX)).equals(original)).toBe(true);
  });
});

describe("apply internalize-export", () => {
  it("rewrites a shared named type re-export and verifies", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanBeta");
    const mutation = await applyReductionPlan(plan, {
      beforeWrite: noJournal,
      root,
      write: true,
    });
    expect(mutation.status).toBe("applied");
    expect(mutation.verification?.status).toBe("pass");
    expect(mutation.observedDelta).toEqual({
      exportedSymbols: -1,
      externallyUsedSymbols: 0,
      totalSymbols: 0,
      unusedExternalExports: -1,
    });
    const index = readFileSync(
      join(root, "packages/plans/src/index.ts"),
      "utf8"
    );
    expect(index).toContain("PlanBetaExtra");
    expect(index).not.toMatch(expectedTextPattern);
    // the module export and its internal consumer survive untouched
    const bar = readFileSync(join(root, "packages/plans/src/bar.ts"), "utf8");
    expect(bar).toContain("export interface PlanBeta");
    expect(
      readFileSync(join(root, "packages/plans/src/internal.ts"), "utf8")
    ).toContain('from "./bar"');
  });

  it("removes the export modifier for a direct entrypoint declaration", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanDirect");
    const mutation = await applyReductionPlan(plan, {
      beforeWrite: noJournal,
      root,
      write: true,
    });
    expect(mutation.status).toBe("applied");
    expect(mutation.verification?.status).toBe("pass");
    const index = readFileSync(
      join(root, "packages/plans/src/index.ts"),
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
    const mutation = await applyReductionPlan(plan, {
      beforeWrite: noJournal,
      root,
      write: true,
    });
    expect(mutation.status).toBe("applied");
    expect(mutation.changedFiles.length).toBeGreaterThan(1);
    expect(mutation.verification?.status).toBe("pass");
  });

  it("refuses to apply an unsupported star-export plan", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans-star" });
    const plan = internalizePlan(report, "PlanHidden");
    expect(plan.status).toBe("unsupported");
    const mutation = await applyReductionPlan(plan, {
      beforeWrite: noJournal,
      root,
      write: true,
    });
    expect(mutation.status).toBe("unsupported");
    expect(gitStatus(root)).toBe("");
  });

  it("blocks when a planned file has uncommitted changes", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanAlpha");
    const index = join(root, "packages/plans/src/index.ts");
    appendFileSync(index, "// local edit\n");
    const mutation = await applyReductionPlan(plan, {
      beforeWrite: noJournal,
      root,
      write: true,
    });
    expect(mutation.status).toBe("blocked");
    expect(mutation.blockers?.map((blocker) => blocker.reason)).toContain(
      "dirty-working-tree"
    );
    expect(readFileSync(index, "utf8")).toContain("// local edit");
  });

  it("writes only the planned file, keeps its mode, and is not blocked by a dirty file it does not write", async () => {
    const root = tempFixture();
    chmodSync(join(root, INDEX), 0o640);
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const unrelated = join(root, "packages/beta/src/index.ts");
    appendFileSync(unrelated, "// local edit\n");
    const mutation = await applyReductionPlan(
      internalizePlan(report, "PlanDirect"),
      { beforeWrite: noJournal, root, write: true }
    );
    expect(mutation.status).toBe("applied");
    expect(statSync(join(root, INDEX)).mode % 0o1_0000).toBe(0o640);
    expect(
      gitStatus(root)
        .split("\n")
        .map((line) => line.trim())
        .sort()
    ).toEqual([
      "M packages/beta/src/index.ts",
      "M packages/plans/src/index.ts",
    ]);
  });

  it("keeps a byte order mark that ts-morph drops", async () => {
    const root = tempFixture({}, (dir) => {
      const index = join(dir, INDEX);
      writeFileSync(
        index,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(index)])
      );
    });
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const before = readFileSync(join(root, INDEX));
    const mutation = await applyReductionPlan(
      internalizePlan(report, "PlanDirect"),
      { beforeWrite: noJournal, root, write: true }
    );
    expect(mutation.status).toBe("applied");
    const after = readFileSync(join(root, INDEX));
    expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(after.toString("utf8")).toBe(
      before
        .toString("utf8")
        .replace("export interface PlanDirect {", "interface PlanDirect {")
    );
  });

  it("restores the bytes and mode of every written file when verification throws", async () => {
    const root = tempFixture();
    chmodSync(join(root, INDEX), 0o600);
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const original = readFileSync(join(root, INDEX));
    let written: Buffer | undefined;
    await expect(
      applyReductionPlan(internalizePlan(report, "PlanAlpha"), {
        analyzeAfter: () => {
          written = readFileSync(join(root, INDEX));
          throw new Error("the analysis crashed");
        },
        beforeWrite: noJournal,
        root,
        write: true,
      })
    ).rejects.toThrow("the analysis crashed");
    expect(written?.equals(original)).toBe(false);
    expect(readFileSync(join(root, INDEX)).equals(original)).toBe(true);
    expect(statSync(join(root, INDEX)).mode % 0o1_0000).toBe(0o600);
    expect(gitStatus(root)).toBe("");
  });

  it("restores only a file that still holds what it wrote, and names one changed since", () => {
    const root = tempFixture();
    const file = (name: string, bytes: string) => {
      writeFileSync(join(root, name), bytes);
      return {
        file: name,
        original: { bytes: Buffer.from("original"), mode: 0o644 },
        writtenHash: sha256(Buffer.from("written")),
      };
    };
    const kept = file("kept.ts", "original");
    const restored = file("restored.ts", "written");
    const changed = file("changed.ts", "someone else");
    const cause = new Error("verification threw");
    let thrown: unknown;
    try {
      restoreWritten(root, [kept, changed, restored], cause);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "Atlas did not restore every file it wrote: changed.ts changed after Atlas wrote it, so restoring it would overwrite that change. Restore changed.ts from Git."
    );
    expect((thrown as Error).cause).toBe(cause);
    expect(readFileSync(join(root, "restored.ts"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "changed.ts"), "utf8")).toBe("someone else");
  });

  it("restores every other file when one restore fails, then throws once", () => {
    const root = tempFixture();
    const locked = join(root, "locked");
    mkdirSync(locked);
    const entry = (name: string) => {
      writeFileSync(join(root, name), "written");
      return {
        file: name,
        original: { bytes: Buffer.from("original"), mode: 0o644 },
        writtenHash: sha256(Buffer.from("written")),
      };
    };
    const first = entry("first.ts");
    const stuck = entry("locked/stuck.ts");
    const last = entry("last.ts");
    // No temporary can be created beside the stuck file.
    chmodSync(locked, 0o555);
    try {
      expect(() => restoreWritten(root, [first, stuck, last])).toThrow(
        "Atlas did not restore every file it wrote: restoring locked/stuck.ts failed:"
      );
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(readFileSync(join(root, "first.ts"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "last.ts"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "locked/stuck.ts"), "utf8")).toBe("written");
  });

  it("refuses a planned file it could not write back byte for byte, such as one that is not UTF-8", async () => {
    const root = tempFixture({}, (dir) => {
      const index = join(dir, INDEX);
      writeFileSync(
        index,
        Buffer.concat([
          Buffer.from("// caf"),
          Buffer.from([0xe9]),
          Buffer.from("\n"),
          readFileSync(index),
        ])
      );
    });
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const before = readFileSync(join(root, INDEX));
    for (const write of [false, true]) {
      const mutation = await applyReductionPlan(
        internalizePlan(report, "PlanDirect"),
        { root, write }
      );
      expect(mutation.status).toBe("blocked");
      expect(mutation.blockers).toEqual([
        {
          detail: `${INDEX} would not be written back byte for byte: it is not UTF-8, or it changed while Atlas read it.`,
          reason: "apply-unsupported",
        },
      ]);
    }
    expect(readFileSync(join(root, INDEX)).equals(before)).toBe(true);
  });

  it("checks each file against the rollback's hash just before the first write, and writes nothing on a mismatch", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanDirect");
    const original = readFileSync(join(root, INDEX));
    for (const expectedHashes of [
      new Map([[INDEX, "0".repeat(64)]]),
      new Map<string, string>(),
    ]) {
      let journaled = false;
      const mutation = await applyReductionPlan(plan, {
        beforeWrite: () => {
          journaled = true;
          return Promise.resolve();
        },
        expectedHashes,
        root,
        write: true,
      });
      expect(mutation.status).toBe("stale");
      expect(mutation.blockers).toEqual([
        {
          detail: `${INDEX} is not the file readiness recorded for the rollback; it changed before the write. Nothing was written.`,
          reason: "stale-plan",
        },
      ]);
      expect(journaled).toBe(false);
    }
    await expect(
      applyReductionPlan(plan, {
        beforeWrite: () => Promise.reject(new Error("the journal failed")),
        expectedHashes: new Map([[INDEX, sha256(original)]]),
        root,
        write: true,
      })
    ).rejects.toThrow("the journal failed");
    expect(readFileSync(join(root, INDEX)).equals(original)).toBe(true);
  });

  it("writes only with a journal to restore from", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const original = readFileSync(join(root, INDEX));
    await expect(
      applyReductionPlan(internalizePlan(report, "PlanDirect"), {
        root,
        write: true,
      })
    ).rejects.toThrow(
      "applyReductionPlan writes only with a beforeWrite journal"
    );
    expect(readFileSync(join(root, INDEX)).equals(original)).toBe(true);
  });

  it("rolls back byte-for-byte when verification fails", async () => {
    const root = tempFixture();
    const report = await analyzeSurface({ root, target: "@deps/plans" });
    const plan = internalizePlan(report, "PlanAlpha");
    const index = join(root, "packages/plans/src/index.ts");
    const original = readFileSync(index, "utf8");
    // the fingerprint covers input facts, not the derived delta — a wrong
    // prediction passes validation and must be caught by verification
    const lying: InternalizeSymbolPlan = {
      ...plan,
      predictedDelta: { ...plan.predictedDelta, unusedExternalExports: -2 },
    };
    const mutation = await applyReductionPlan(lying, {
      beforeWrite: noJournal,
      root,
      write: true,
    });
    expect(mutation.status).toBe("rolled-back");
    expect(mutation.verification?.status).toBe("fail");
    expect(readFileSync(index, "utf8")).toBe(original);
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
