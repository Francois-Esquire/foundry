import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planRecordFile, planSite, resolveSite } from "../../src/lib/codemod";
import type { ReadinessCommandRunner } from "../../src/lib/operator-readiness";
import type { ReadinessCommand } from "../../src/lib/operator-readiness-types";
import { renderPlan } from "../../src/lib/render";
import type { Rule } from "../../src/lib/rule-declaration";
import { scan } from "../../src/lib/scan";
import type { WorkspaceState } from "../../src/lib/state";
import { workspaceState } from "../../src/lib/state";
import { commitFixture } from "../helpers/commit-fixture";

const FIXTURE = resolve(import.meta.dirname, "fixtures/deps");
const READY = "packages/plans/src/foo.ts#PlanAlpha";
const ALSO_READY = "packages/plans/src/bar.ts#PlanBeta";
const PUBLISHABLE = "packages/plans-pub/src/index.ts#PlanPublic";
const UNSUPPORTED = "packages/plans/src/index.ts#PlanDirectUsed";
const UNPERMITTED = "packages/beta/src/index.ts#betaMetric";
const RULES: Rule[] = [
  { effect: "permit", operator: "internalize", subject: "packages/plans" },
  { effect: "permit", operator: "internalize", subject: "packages/plans-pub" },
];
/** Wide enough that no line wraps, whatever the temporary path. */
const UNWRAPPED = { width: 1000 };

const pass: ReadinessCommandRunner = () => ({ exitCode: 0, output: "" });
const refuse: ReadinessCommandRunner = () => {
  throw new Error("a baseline command ran");
};

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

  // A copy of the deps fixture: every package private unless the fixture
  // publishes it, each with a test script for readiness to run, committed,
  // and a rule permitting internalize in two of its packages.
  beforeAll(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "atlas-plan-")));
    root = join(directory, "workspace");
    cpSync(FIXTURE, root, { recursive: true });
    for (const name of readdirSync(join(root, "packages"))) {
      const file = join(root, "packages", name, "package.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(
        file,
        JSON.stringify({
          ...manifest,
          private: manifest.private ?? true,
          scripts: { test: "true" },
        })
      );
    }
    mkdirSync(join(root, ".foundry/atlas"), { recursive: true });
    writeFileSync(
      join(root, ".foundry/atlas/rules.ts"),
      `export default { rules: ${JSON.stringify(RULES)} };\n`
    );
    commitFixture(root);
    state = join(directory, "state");
    await scan.workspace(root, { state });
    workspace = await workspaceState(root, state);
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
        `  verify-symbol-location · ${READY} · checked by Atlas`,
        `  verify-public-surface · @deps/plans, ${READY} · checked by Atlas`,
        "  typecheck · @deps/plans · checked by Atlas",
        "  tests · @deps/plans · bun run test in packages/plans",
        "  analyze-package · @deps/plans · checked by Atlas",
        "",
        "Next",
        `  Run atlas apply internalize-symbol:${READY} to preview; add --write to write.`,
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
      `No rule permits internalize on ${UNPERMITTED}. Declare { effect: "permit", operator: "internalize", subject: "${UNPERMITTED}" }, or a subject above it, under rules in .foundry/atlas/, then scan again.`
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
          reason: "internalize-export does not perform rewrite-import",
        },
      },
      UNWRAPPED
    );
    expect(text).toContain(
      "■ Not executable\n  No mutator executes it: internalize-export does not perform rewrite-import."
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

  it("refuses while an apply's journal exists", async () => {
    const journal = join(workspace.directory, "apply/journal.json");
    mkdirSync(join(workspace.directory, "apply"), { recursive: true });
    writeFileSync(journal, "{}");
    try {
      await expect(plan(ALSO_READY, pass)).rejects.toThrow(
        `An atlas apply did not finish (${journal} exists), so the saved dataset may not describe the sources.`
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
    const rules = join(root, ".foundry/atlas/rules.ts");
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
