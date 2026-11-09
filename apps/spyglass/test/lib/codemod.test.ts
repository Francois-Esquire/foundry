import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { deleteJournal, writeJournal } from "../../src/lib/apply-journal";
import { planRecordFile, planSite, resolveSite } from "../../src/lib/codemod";
import { applyRecord } from "../../src/lib/codemod-apply";
import type { PackageReport } from "../../src/lib/dataset";
import { datasetReader } from "../../src/lib/dataset";
import { STALE_DATASET } from "../../src/lib/dataset-current";
import { fileTransport } from "../../src/lib/dataset-files";
import type { ReadinessCommandRunner } from "../../src/lib/operator-readiness";
import type { ReadinessCommand } from "../../src/lib/operator-readiness-types";
import { renderPlan } from "../../src/lib/render";
import { scan } from "../../src/lib/scan";
import type { WorkspaceState } from "../../src/lib/state";
import { lockState } from "../../src/lib/state";
import {
  ALSO_READY,
  journalFor,
  PUBLISHABLE,
  pass,
  READY,
  RULES,
  refuse,
  scannedCopy,
  UNPERMITTED,
  UNSUPPORTED,
  UNWRAPPED,
} from "../helpers/codemod-fixture";
import { scanCacheSeeds } from "../helpers/scan-cache-seeds";

/** Every scanned copy after the first of its kind starts from that copy's cache. */
const seeds = scanCacheSeeds();
afterAll(seeds.dispose);

describe("resolveSite", () => {
  it("reads an opportunity id, its plan id, and the bare path#name alike", () => {
    const site = {
      opportunity: `internalize-symbol:${READY}`,
      place: READY,
      planId: `plan:internalize-symbol:${READY}`,
    };
    expect(resolveSite(READY)).toEqual(site);
    expect(resolveSite(`internalize-symbol:${READY}`)).toEqual(site);
    expect(resolveSite(`plan:internalize-symbol:${READY}`)).toEqual(site);
  });

  it("refuses any other shape, another operation's id included", () => {
    for (const word of [
      "packages/plans",
      "packages/plans/src/foo.ts#",
      "#PlanAlpha",
      "fold-package:@deps/plans",
      "plan:fold-package:packages/plans#x",
      "internalize-symbol:",
      "packages/a#b/src/x.ts#X",
    ]) {
      expect(() => resolveSite(word), word).toThrow(
        `${word} names no internalize opportunity. Write internalize-symbol:<path#name>, its plan id, or <path#name>.`
      );
    }
  });
});

describe("planSite", () => {
  let directory: string;
  let root: string;
  let state: string;
  let workspace: WorkspaceState;

  const plan = (site: string, runner: ReadinessCommandRunner = refuse) =>
    planSite(root, resolveSite(site), { runner, state });
  const recordOf = (site: string) =>
    planRecordFile(workspace, resolveSite(site).planId);
  const status = () =>
    execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString();

  beforeAll(async () => {
    ({ directory, root, state, workspace } = await scannedCopy(
      seeds,
      "spyglass-plan-"
    ));
  });

  afterAll(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("authorizes a ready plan under a permit, saves its record in the state directory, and writes nothing in the workspace", async () => {
    const ran: ReadinessCommand[] = [];
    const result = await plan(READY, (command, at) => {
      ran.push(command);
      return pass(command, at);
    });
    if (result.verdict.kind !== "authorized") {
      throw new Error(`not authorized: ${JSON.stringify(result.verdict)}`);
    }
    expect(result.record).toBe(recordOf(READY));
    expect(dirname(recordOf(READY))).toBe(join(workspace.directory, "plans"));
    expect(JSON.parse(readFileSync(recordOf(READY), "utf8"))).toEqual(
      result.verdict.record
    );
    expect(result.verdict.record.permittedBy).toEqual([0]);
    expect(result.verdict.record.execution.planId).toBe(
      `plan:internalize-symbol:${READY}`
    );
    expect(ran).toEqual([
      {
        args: ["run", "test"],
        cwd: "packages/plans",
        executable: "bun",
        expectedExitCode: 0,
      },
    ]);
    expect(status()).toBe("");
    expect(renderPlan(result, UNWRAPPED)).toBe(
      [
        `Plan for ${READY}`,
        "═".repeat(`Plan for ${READY}`.length),
        `Opportunity  internalize-symbol:${READY}`,
        "Package      @deps/plans",
        "Saved plan   ready",
        "◇ Authorized",
        `  Permitted by rules[0]. The record is saved to ${recordOf(READY)}.`,
        "",
        "Planned changes",
        '  packages/plans/src/index.ts: Remove the statement: export type { PlanAlpha } from "./foo";',
        "",
        "Verification apply runs",
        `  verify-symbol-location · ${READY} · checked by Spyglass`,
        `  verify-public-surface · @deps/plans, ${READY} · checked by Spyglass`,
        "  typecheck · @deps/plans · checked by Spyglass",
        "  tests · @deps/plans · bun run test in packages/plans",
        "  analyze-package · @deps/plans · checked by Spyglass",
        "",
        "Next",
        `  Run spyglass apply internalize-symbol:${READY} to preview; add --write to write.`,
      ].join("\n")
    );
  });

  it("refuses a site no rule permits, before any baseline runs, and saves no record", async () => {
    const result = await plan(UNPERMITTED);
    expect(result.verdict).toEqual({
      kind: "refused-by-rule",
      refused: [
        {
          operator: "internalize",
          operatorId: expect.any(String),
          place: UNPERMITTED,
        },
      ],
    });
    expect(result.record).toBeUndefined();
    expect(existsSync(recordOf(UNPERMITTED))).toBe(false);
    expect(renderPlan(result, UNWRAPPED)).toContain(
      `No rule permits internalize on ${UNPERMITTED}. Declare { effect: "permit", operator: "internalize", subject: "${UNPERMITTED}" }, or a subject above it, under rules in .foundry/spyglass/, then scan again.`
    );
  });

  it("says why a publishable package's plan is blocked, and saves no record", async () => {
    const result = await plan(PUBLISHABLE);
    expect(result.verdict).toEqual({
      kind: "not-executable",
      reason: `the saved plan plan:internalize-symbol:${PUBLISHABLE} is blocked: publishable`,
    });
    expect(result.plan.status).toBe("blocked");
    expect(result.plan.blockers.map((blocker) => blocker.reason)).toEqual([
      "publishable",
    ]);
    expect(existsSync(recordOf(PUBLISHABLE))).toBe(false);
    const text = renderPlan(result, UNWRAPPED);
    expect(text).toContain(
      "■ Blocked\n  The saved plan is blocked; see its reasons below."
    );
    expect(text).toContain(
      'publishable: the package is marked "private": false, so consumers outside this repository are invisible.'
    );
  });

  it("judges a plan that is not ready not executable, before any baseline runs", async () => {
    const result = await plan(UNSUPPORTED);
    expect(result.verdict).toEqual({
      kind: "not-executable",
      reason: `the saved plan plan:internalize-symbol:${UNSUPPORTED} is unsupported: internal-entrypoint-import`,
    });
    expect(existsSync(recordOf(UNSUPPORTED))).toBe(false);
    expect(renderPlan(result, UNWRAPPED)).toContain(
      "■ Unsupported\n  The saved plan is unsupported; see its reasons below."
    );
  });

  it("titles a plan the bridge refuses for another reason not executable", async () => {
    const result = await plan(READY, pass);
    const text = renderPlan(
      {
        ...result,
        verdict: {
          kind: "not-executable",
          reason: "internalize-export does not perform update-test-import",
        },
      },
      UNWRAPPED
    );
    expect(text).toContain(
      "■ Not executable\n  No mutator executes it: internalize-export does not perform update-test-import."
    );
  });

  it("answers with readiness's verdict, and saves no record, when a baseline fails now", async () => {
    const result = await plan(ALSO_READY, () => ({
      exitCode: 1,
      output: "1 test failed",
    }));
    expect(result.verdict.kind).toBe("readiness");
    expect(
      result.verdict.kind === "readiness" &&
        result.verdict.readiness.authorization
    ).toBe("blocked");
    expect(existsSync(recordOf(ALSO_READY))).toBe(false);
    expect(renderPlan(result, UNWRAPPED)).toContain(
      "■ Blocked\n  Readiness did not authorize it, with 1 blocker(s)."
    );
  });

  it.runIf(process.platform !== "win32")(
    "writes the apply journal readable only by its owner",
    async () => {
      const journal = join(workspace.directory, "apply/journal.json");
      try {
        await writeJournal(workspace, journalFor(READY, "writing", []));
        // The permission bits: the mode below its file-type bits.
        expect(statSync(journal).mode % 0o1000).toBe(0o600);
      } finally {
        rmSync(join(workspace.directory, "apply"), {
          force: true,
          recursive: true,
        });
      }
    }
  );

  it("refuses while an apply's journal exists", async () => {
    const journal = join(workspace.directory, "apply/journal.json");
    await writeJournal(workspace, journalFor(READY, "writing", []));
    try {
      await expect(plan(ALSO_READY, pass)).rejects.toThrow(
        `An spyglass apply of ${READY} (${journal}) was interrupted while it wrote the sources. Run spyglass apply to restore them.`
      );
      await writeJournal(workspace, journalFor(READY, "verified", []));
      await expect(plan(ALSO_READY, pass)).rejects.toThrow(
        `An spyglass apply of ${READY} (${journal}) wrote and verified the sources, but the scan after it did not publish, so the saved dataset does not describe them. Run spyglass scan.`
      );
      expect(existsSync(recordOf(ALSO_READY))).toBe(false);
    } finally {
      rmSync(join(workspace.directory, "apply"), {
        force: true,
        recursive: true,
      });
    }
  });

  it("deletes a site's record once a plan of it is no longer authorized", async () => {
    const rules = join(root, ".foundry/spyglass/rules.ts");
    const declared = readFileSync(rules, "utf8");
    expect((await plan(READY, pass)).verdict.kind).toBe("authorized");
    expect(existsSync(recordOf(READY))).toBe(true);
    try {
      writeFileSync(
        rules,
        `export default { rules: ${JSON.stringify(RULES.slice(1))} };\n`
      );
      await scan.workspace(root, { state });
      expect((await plan(READY)).verdict.kind).toBe("refused-by-rule");
      expect(existsSync(recordOf(READY))).toBe(false);
    } finally {
      writeFileSync(rules, declared);
      await scan.workspace(root, { state });
    }
  });

  it("fails for a site the dataset does not hold", async () => {
    await expect(plan("packages/plans/src/none.ts#Nothing")).rejects.toThrow(
      "packages/plans/src/none.ts is not a module of the saved dataset."
    );
    await expect(plan("packages/plans/src/foo.ts#Nothing")).rejects.toThrow(
      "@deps/plans records no opportunity internalize-symbol:packages/plans/src/foo.ts#Nothing."
    );
  });
});

describe("applyRecord, previewing", () => {
  const INDEX = "packages/plans/src/index.ts";
  const RULES_FILE = ".foundry/spyglass/rules.ts";
  let directory: string;
  let root: string;
  let state: string;
  let workspace: WorkspaceState;

  const plan = async (site: string) => {
    const planned = await planSite(root, resolveSite(site), {
      runner: pass,
      state,
    });
    expect(planned.verdict.kind).toBe("authorized");
  };
  const apply = (site: string, runner: ReadinessCommandRunner = pass) =>
    applyRecord(root, resolveSite(site), { runner, state });
  const status = () =>
    execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString();
  /** Runs `body` with a workspace file rewritten, then puts it back. */
  const withFile = async (
    file: string,
    edit: (text: string) => string,
    body: () => Promise<void>
  ) => {
    const path = join(root, file);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, edit(original));
    try {
      await body();
    } finally {
      writeFileSync(path, original);
    }
  };
  const rescan = () => scan.workspace(root, { state });
  /** As `withFile`, with the dataset scanned after the edit and again after it is undone, so it stays current. */
  const withScannedFile = (
    file: string,
    edit: (text: string) => string,
    body: () => Promise<void>
  ) =>
    withFile(file, edit, async () => {
      await rescan();
      await body();
    }).finally(rescan);

  beforeAll(async () => {
    ({ directory, root, state, workspace } = await scannedCopy(
      seeds,
      "spyglass-apply-"
    ));
  });

  afterAll(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("previews the authorized plan, authorizing it again with its baseline, and writes nothing", async () => {
    await plan(READY);
    let baselines = 0;
    const result = await apply(READY, (command, at) => {
      baselines += 1;
      return pass(command, at);
    });
    expect(result).toEqual({
      changedFiles: [INDEX],
      edits: [
        {
          after: null,
          before: 'export type { PlanAlpha } from "./foo";',
          file: INDEX,
        },
      ],
      mode: "preview",
      planId: `plan:internalize-symbol:${READY}`,
      site: READY,
      status: "preview",
    });
    expect(baselines).toBe(1);
    expect(status()).toBe("");
    expect(
      existsSync(planRecordFile(workspace, resolveSite(READY).planId))
    ).toBe(true);
  });

  it("fails without a saved record, and asks for a plan", async () => {
    await expect(apply(ALSO_READY)).rejects.toThrow(
      `No authorized plan is saved for internalize-symbol:${ALSO_READY}. Run spyglass plan internalize-symbol:${ALSO_READY} first.`
    );
  });

  it("refuses a dataset that no longer describes the sources, and plan fails early on one", async () => {
    await plan(READY);
    await withFile(
      INDEX,
      (text) => `${text}// edited\n`,
      async () => {
        expect((await apply(READY, refuse)).refusal).toEqual({
          kind: "stale-dataset",
          reason: STALE_DATASET,
        });
        await expect(
          planSite(root, resolveSite(READY), { runner: refuse, state })
        ).rejects.toThrow(STALE_DATASET);
      }
    );
    expect((await apply(READY)).status).toBe("preview");
  });

  it("names the source, and the file, when a planned file changed since the plan and was scanned again", async () => {
    await plan(READY);
    await withScannedFile(
      INDEX,
      (text) => `${text}// edited\n`,
      async () => {
        const result = await apply(READY);
        expect(result.status).toBe("refused");
        expect(result.refusal).toEqual({
          kind: "authorization-changed",
          parts: [
            { files: [INDEX], part: "source" },
            { part: "plan" },
            { part: "rollback" },
          ],
        });
        expect(result.edits).toEqual([]);
      }
    );
  });

  it("names the rule when the configuration's rules moved, and refuses by rule when none permits", async () => {
    await plan(READY);
    await withFile(
      RULES_FILE,
      () =>
        `export default { rules: ${JSON.stringify([{ effect: "require", operator: "internalize", subject: "packages/none" }, ...RULES])} };\n`,
      async () => {
        expect((await apply(READY)).refusal).toEqual({
          kind: "authorization-changed",
          parts: [{ part: "rule" }],
        });
      }
    );
    await withFile(
      RULES_FILE,
      () => `export default { rules: ${JSON.stringify(RULES.slice(1))} };\n`,
      async () => {
        expect((await apply(READY, refuse)).refusal?.kind).toBe(
          "refused-by-rule"
        );
      }
    );
  });

  it("names a part tampered in the record, and the Spyglass version when only the hash differs", async () => {
    await plan(READY);
    const file = planRecordFile(workspace, resolveSite(READY).planId);
    const saved = readFileSync(file, "utf8");
    const record = JSON.parse(saved);
    try {
      writeFileSync(
        file,
        JSON.stringify({
          ...record,
          authorizationFingerprint: {
            ...record.authorizationFingerprint,
            capabilityFingerprint: "0000000000000000",
          },
        })
      );
      expect((await apply(READY)).refusal).toEqual({
        kind: "authorization-changed",
        parts: [{ part: "capability" }],
      });
      writeFileSync(
        file,
        JSON.stringify({
          ...record,
          authorizationFingerprint: {
            ...record.authorizationFingerprint,
            hash: "auth:0000000000000000",
          },
        })
      );
      expect((await apply(READY)).refusal).toEqual({
        kind: "authorization-changed",
        parts: [{ part: "spyglass-version" }],
      });
    } finally {
      writeFileSync(file, saved);
    }
  });

  it("refuses a dirty file it writes", async () => {
    await withScannedFile(
      INDEX,
      (text) => `${text}// local edit\n`,
      async () => {
        await plan(READY);
        expect((await apply(READY)).refusal).toEqual({
          files: [INDEX],
          kind: "dirty",
        });
      }
    );
  });

  it("previews with dirty files it only reads or never touches", async () => {
    await withFile(
      "packages/plans/src/foo.ts",
      (text) => `${text}// local edit\n`,
      () =>
        withFile(
          "packages/beta/src/index.ts",
          (text) => `${text}// local edit\n`,
          async () => {
            await rescan();
            await plan(READY);
            expect((await apply(READY)).status).toBe("preview");
          }
        )
    ).finally(rescan);
  });

  it("waits for a scan after a verified write, and refuses while another process holds the lock", async () => {
    await plan(READY);
    await writeJournal(workspace, journalFor(READY, "verified", []));
    try {
      expect((await apply(READY)).refusal).toEqual({
        kind: "pending-write",
        phase: "verified",
        site: READY,
      });
    } finally {
      deleteJournal(workspace);
    }
    const release = lockState(workspace);
    try {
      await expect(apply(READY)).rejects.toThrow(
        `Workspace ${root} is being scanned, exported, or applied by this process.`
      );
    } finally {
      release();
    }
    expect((await apply(READY)).status).toBe("preview");
  });
});

describe("the saved report as apply's before and after", () => {
  let directory: string;
  let root: string;
  let workspace: WorkspaceState;

  beforeAll(async () => {
    ({ directory, root, workspace } = await scannedCopy(
      seeds,
      "spyglass-reports-"
    ));
  });

  afterAll(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  /**
   * Every field `validateReductionPlan`, `verifyInternalizeExport`, and the
   * mutator read from a package report: the symbols' identity, exposure,
   * and outside use; each internalize plan whole; the summary's counts.
   */
  function readFields(report: PackageReport) {
    return {
      plans: report.plans.filter(
        (plan) => plan.operation === "internalize-symbol"
      ),
      summary: {
        externallyUsedSymbols: report.summary.externallyUsedSymbols,
        totalSymbols: report.summary.totalSymbols,
      },
      symbols: report.symbols.map((symbol) => ({
        consumerPackages: symbol.consumerPackages,
        declarationFile: symbol.declarationFile,
        externalImportSites: symbol.externalImportSites,
        externalReferences: symbol.externalReferences,
        id: symbol.id,
        packagePublic: symbol.packagePublic,
      })),
    };
  }

  it("agrees with a fresh analysis on every field validation and verification read", async () => {
    const reader = datasetReader(fileTransport(workspace.output));
    for (const name of [
      "@deps/plans",
      "@deps/plans-multi",
      "@deps/plans-pub",
    ]) {
      const saved = await reader.packageReport(name);
      const fresh = await analyzeSurface({
        root,
        target: saved.target.path,
      });
      expect(readFields(saved), name).toEqual(readFields(fresh));
    }
  });
});
