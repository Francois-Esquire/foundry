import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../../src/lib/apply";
import type { ApplyJournal } from "../../src/lib/apply-journal";
import { deleteJournal, writeJournal } from "../../src/lib/apply-journal";
import { check } from "../../src/lib/check";
import { planRecordFile, planSite, resolveSite } from "../../src/lib/codemod";
import { applyRecord } from "../../src/lib/codemod-apply";
import type { ReadinessCommandRunner } from "../../src/lib/operator-readiness";
import { spawnRunner } from "../../src/lib/operator-readiness";
import type { ReadinessCommand } from "../../src/lib/operator-readiness-types";
import { renderPlan } from "../../src/lib/render";
import type { Rule } from "../../src/lib/rule-declaration";
import { scan } from "../../src/lib/scan";
import type { WorkspaceState } from "../../src/lib/state";
import { lockState, workspaceState } from "../../src/lib/state";
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

/** A journal an apply left, for the refusals that read it. */
function journalFor(
  site: string,
  phase: ApplyJournal["phase"],
  files: ApplyJournal["files"]
): ApplyJournal {
  return {
    files,
    phase,
    planId: `plan:internalize-symbol:${site}`,
    schemaVersion: 1,
    site,
    startedAt: "2026-10-10T00:00:00.000Z",
  };
}

/**
 * A scanned copy of the deps fixture: every package private unless the
 * fixture publishes it, each with a test script for readiness to run,
 * committed unless `git` is false, and a rule permitting internalize in two
 * of its packages.
 */
async function scannedCopy(
  prefix: string,
  { git = true, history = false }: { git?: boolean; history?: boolean } = {}
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const root = join(directory, "workspace");
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
  if (git) {
    commitFixture(root);
  }
  const state = join(directory, "state");
  await scan.workspace(root, { history, state });
  return {
    directory,
    root,
    state,
    workspace: await workspaceState(root, state),
  };
}

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
    ({ directory, root, state, workspace } = await scannedCopy("atlas-plan-"));
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
    await writeJournal(workspace, journalFor(READY, "writing", []));
    try {
      await expect(plan(ALSO_READY, pass)).rejects.toThrow(
        `An atlas apply of ${READY} (${journal}) was interrupted while it wrote the sources. Run atlas apply to restore them.`
      );
      await writeJournal(workspace, journalFor(READY, "verified", []));
      await expect(plan(ALSO_READY, pass)).rejects.toThrow(
        `An atlas apply of ${READY} (${journal}) wrote and verified the sources, but the scan after it did not publish, so the saved dataset does not describe them. Run atlas scan.`
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

describe("applyRecord, previewing", () => {
  const INDEX = "packages/plans/src/index.ts";
  const RULES_FILE = ".foundry/atlas/rules.ts";
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

  beforeAll(async () => {
    ({ directory, root, state, workspace } = await scannedCopy("atlas-apply-"));
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
      `No authorized plan is saved for internalize-symbol:${ALSO_READY}. Run atlas plan internalize-symbol:${ALSO_READY} first.`
    );
  });

  it("names the source, and the file, when a planned file changed since the plan", async () => {
    await plan(READY);
    await withFile(
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

  it("names a part tampered in the record, and the Atlas version when only the hash differs", async () => {
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
        parts: [{ part: "atlas-version" }],
      });
    } finally {
      writeFileSync(file, saved);
    }
  });

  it("refuses a dirty file it writes, and not one it only reads or never touches", async () => {
    await withFile(
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
    await withFile(
      "packages/plans/src/foo.ts",
      (text) => `${text}// local edit\n`,
      () =>
        withFile(
          "packages/beta/src/index.ts",
          (text) => `${text}// local edit\n`,
          async () => {
            await plan(READY);
            expect((await apply(READY)).status).toBe("preview");
          }
        )
    );
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

describe("applyRecord, writing", () => {
  const INDEX = "packages/plans/src/index.ts";
  const directories: string[] = [];
  const WRITE_TIMEOUT = 120_000;

  afterAll(() => {
    for (const directory of directories) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  /** A fresh scanned copy, with the plan for READY authorized. */
  async function planned(options: { git?: boolean; history?: boolean } = {}) {
    const copy = await scannedCopy("atlas-write-", options);
    directories.push(copy.directory);
    const site = resolveSite(READY);
    const authorized = await planSite(copy.root, site, {
      runner: pass,
      state: copy.state,
    });
    expect(authorized.verdict.kind).toBe("authorized");
    const read = (file: string) => readFileSync(join(copy.root, file));
    const journal = join(copy.workspace.directory, "apply/journal.json");
    const record = planRecordFile(copy.workspace, site.planId);
    const write = (overrides: Parameters<typeof applyRecord>[2] = {}) =>
      applyRecord(copy.root, site, {
        runner: pass,
        state: copy.state,
        write: true,
        ...overrides,
      });
    const status = () =>
      execFileSync("git", ["status", "--porcelain"], {
        cwd: copy.root,
      }).toString();
    return { ...copy, journal, read, record, site, status, write };
  }

  /** A runner that passes the baseline, then answers `after` for every run after the write. */
  function afterTheWrite(
    after: ReadinessCommandRunner
  ): ReadinessCommandRunner & { runs: number } {
    const runner = Object.assign(
      (command: ReadinessCommand, at: string) => {
        runner.runs += 1;
        return runner.runs === 1 ? pass(command, at) : after(command, at);
      },
      { runs: 0 }
    );
    return runner;
  }

  it(
    "journals before it writes, verifies, scans again, keeps history, and then deletes the record and the journal",
    async () => {
      const copy = await planned({ history: true });
      const historyManifest = join(
        copy.workspace.output,
        "history/manifest.json"
      );
      const savedHistory = readFileSync(historyManifest, "utf8");
      const before = JSON.parse(
        readFileSync(join(copy.workspace.output, "manifest.json"), "utf8")
      );
      const original = copy.read(INDEX);
      let journal: ApplyJournal | undefined;
      const runner = afterTheWrite((command, at) => {
        journal = JSON.parse(readFileSync(copy.journal, "utf8"));
        return pass(command, at);
      });
      const result = await copy.write({ runner });
      expect(result.status).toBe("applied");
      expect(result.scan).toMatchObject({
        output: copy.workspace.output,
        status: "published",
      });
      expect(result.verification?.status).toBe("pass");
      expect(result.verification?.checks.at(-1)).toEqual({
        check: "tests · @deps/plans",
        detail:
          "bun run test in packages/plans shows no failure it did not show before the write.",
        status: "pass",
      });
      expect(runner.runs).toBe(2);
      expect(journal).toEqual({
        files: [
          {
            file: INDEX,
            mode: statSync(join(copy.root, INDEX)).mode % 0o1_0000,
            original: original.toString("base64"),
            originalHash: sha256(original),
            writtenHash: sha256(copy.read(INDEX)),
          },
        ],
        phase: "writing",
        planId: copy.site.planId,
        schemaVersion: 1,
        site: READY,
        startedAt: expect.any(String),
      });
      expect(copy.read(INDEX).toString("utf8")).not.toContain("PlanAlpha");
      expect(copy.status().trim()).toBe(`M ${INDEX}`);
      expect(existsSync(copy.journal)).toBe(false);
      expect(existsSync(copy.record)).toBe(false);
      const after = JSON.parse(
        readFileSync(join(copy.workspace.output, "manifest.json"), "utf8")
      );
      expect(after.generatedAt > before.generatedAt).toBe(true);
      expect(readFileSync(historyManifest, "utf8")).toBe(savedHistory);
      expect(existsSync(`${copy.workspace.output}.next`)).toBe(false);
      await expect(copy.write()).rejects.toThrow(
        `No authorized plan is saved for ${copy.site.opportunity}.`
      );
    },
    WRITE_TIMEOUT
  );

  it(
    "rolls back byte for byte when a script fails after the write where it passed before",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      const result = await copy.write({
        runner: afterTheWrite(() => ({
          exitCode: 1,
          output: " FAIL  src/plans.test.ts > plans\n",
        })),
      });
      expect(result.status).toBe("rolled-back");
      expect(
        result.verification?.checks.filter((c) => c.status === "fail")
      ).toEqual([
        {
          check: "tests · @deps/plans",
          detail:
            "bun run test in packages/plans fails where it did not before the write: FAIL src/plans.test.ts > plans",
          status: "fail",
        },
      ]);
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(copy.status()).toBe("");
      expect(existsSync(copy.journal)).toBe(false);
      expect(existsSync(copy.record)).toBe(true);
    },
    WRITE_TIMEOUT
  );

  it(
    "fails the step, and rolls back, when a script is killed for running past its timeout",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      const result = await copy.write({
        runner: afterTheWrite((command, at) =>
          spawnRunner({ ...command, args: ["5"], executable: "sleep" }, at, {
            timeoutMs: 200,
          })
        ),
      });
      expect(result.status).toBe("rolled-back");
      expect(
        result.verification?.checks.filter((c) => c.status === "fail")
      ).toEqual([
        {
          check: "tests · @deps/plans",
          detail:
            "bun run test in packages/plans was killed by SIGTERM: it ran past its timeout (ETIMEDOUT).",
          status: "fail",
        },
      ]);
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "refuses before writing when a script fails under the lock, before the write",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      const result = await applyRecord(copy.root, copy.site, {
        runner: () => ({
          exitCode: 1,
          output: " FAIL  src/old.test.ts > known\n",
        }),
        state: copy.state,
        write: true,
      });
      expect(result.status).toBe("refused");
      expect(
        result.refusal?.kind === "readiness" &&
          result.refusal.readiness.authorization
      ).toBe("blocked");
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "restores every written file when a check throws, or a signal arrives",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      await expect(
        copy.write({
          runner: afterTheWrite(() => {
            throw new Error("the test runner crashed");
          }),
        })
      ).rejects.toThrow("the test runner crashed");
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);

      const signals = new EventEmitter();
      await expect(
        copy.write({
          runner: afterTheWrite((command, at) => {
            signals.emit("SIGINT", "SIGINT");
            return pass(command, at);
          }),
          signals,
        })
      ).rejects.toThrow("Interrupted by SIGINT");
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(copy.status()).toBe("");
      expect(existsSync(copy.journal)).toBe(false);
      expect(signals.listenerCount("SIGINT")).toBe(0);

      // A signal whose listener runs only after the last check still undoes
      // the write, before it is marked verified.
      const late = new EventEmitter();
      await expect(
        copy.write({
          runner: afterTheWrite((command, at) => {
            setImmediate(() =>
              setImmediate(() => late.emit("SIGTERM", "SIGTERM"))
            );
            return pass(command, at);
          }),
          signals: late,
        })
      ).rejects.toThrow("Interrupted by SIGTERM");
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
      expect(existsSync(copy.record)).toBe(true);
    },
    WRITE_TIMEOUT
  );

  it(
    "restores an interrupted write on the next apply, and plan, check, and scan refuse it until then",
    async () => {
      const copy = await planned();
      const path = join(copy.root, INDEX);
      const original = copy.read(INDEX);
      const half = Buffer.from(
        original
          .toString("utf8")
          .replace("export type { PlanAlpha }", "type { PlanAlpha }")
      );
      writeFileSync(path, half);
      await writeJournal(
        copy.workspace,
        journalFor(READY, "writing", [
          {
            file: INDEX,
            mode: 0o644,
            original: original.toString("base64"),
            originalHash: sha256(original),
            writtenHash: sha256(half),
          },
        ])
      );
      const interrupted = "was interrupted while it wrote the sources";
      await expect(
        planSite(copy.root, copy.site, { runner: pass, state: copy.state })
      ).rejects.toThrow(interrupted);
      await expect(check(copy.root, { state: copy.state })).rejects.toThrow(
        interrupted
      );
      await expect(
        scan.workspace(copy.root, { state: copy.state })
      ).rejects.toThrow(interrupted);
      const result = await applyRecord(copy.root, resolveSite(ALSO_READY), {
        runner: refuse,
        state: copy.state,
      });
      expect(result.refusal).toEqual({
        kind: "pending-write",
        phase: "writing",
        restored: [INDEX],
        site: READY,
        skipped: [],
      });
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "keeps the journal, and the file, when the file changed since the interrupted write",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      writeFileSync(join(copy.root, INDEX), "// someone else's edit\n");
      await writeJournal(
        copy.workspace,
        journalFor(READY, "writing", [
          {
            file: INDEX,
            mode: 0o644,
            original: original.toString("base64"),
            originalHash: sha256(original),
            writtenHash: sha256(Buffer.from("what Atlas wrote")),
          },
        ])
      );
      await expect(copy.write()).rejects.toThrow(
        `Atlas did not restore every file it wrote: ${INDEX} changed after Atlas wrote it, so restoring it would overwrite that change. Restore ${INDEX} from Git. The journal, ${copy.journal}, keeps every original: restore each file it names from Git (its HEAD content) and the next atlas apply finishes the restore, or delete the journal to keep the files as they are.`
      );
      expect(copy.read(INDEX).toString("utf8")).toBe(
        "// someone else's edit\n"
      );
      expect(existsSync(copy.journal)).toBe(true);
      // Restored from Git, the file holds its original, which the next apply skips.
      writeFileSync(join(copy.root, INDEX), original);
      expect((await copy.write()).refusal).toEqual({
        kind: "pending-write",
        phase: "writing",
        restored: [],
        site: READY,
        skipped: [INDEX],
      });
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "refuses a journal whose copy of a file is damaged",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      await writeJournal(
        copy.workspace,
        journalFor(READY, "writing", [
          {
            file: INDEX,
            mode: 0o644,
            original: Buffer.from("not the original").toString("base64"),
            originalHash: sha256(original),
            writtenHash: sha256(original),
          },
        ])
      );
      await expect(copy.write()).rejects.toThrow(
        `The journal, ${copy.journal}, holds a damaged copy of ${INDEX}`
      );
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(true);
    },
    WRITE_TIMEOUT
  );

  it(
    "keeps a verified write whose scan failed, and the next scan finishes it",
    async () => {
      const copy = await planned();
      const result = await copy.write({
        publish: () => Promise.reject(new Error("the scan crashed")),
      });
      expect(result.status).toBe("applied");
      expect(result.scan).toMatchObject({
        error: "the scan crashed",
        status: "failed",
      });
      expect(copy.read(INDEX).toString("utf8")).not.toContain("PlanAlpha");
      expect(JSON.parse(readFileSync(copy.journal, "utf8")).phase).toBe(
        "verified"
      );
      expect(existsSync(copy.record)).toBe(true);
      expect((await copy.write()).refusal).toMatchObject({
        kind: "pending-write",
        phase: "verified",
      });
      await scan.workspace(copy.root, { state: copy.state });
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "refuses to write outside a Git repository, though it previews",
    async () => {
      const copy = await planned({ git: false });
      const original = copy.read(INDEX);
      expect(
        (
          await applyRecord(copy.root, copy.site, {
            runner: pass,
            state: copy.state,
          })
        ).status
      ).toBe("preview");
      const result = await copy.write();
      expect(result.refusal).toEqual({
        kind: "no-git",
        reason:
          "The workspace is not in a Git repository, so Atlas cannot tell whether a planned file has uncommitted changes. Write only in a repository.",
      });
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );
});
