import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ApplyJournal } from "../../src/lib/apply-journal";
import { planRecordFile, planSite, resolveSite } from "../../src/lib/codemod";
import { applyRecord } from "../../src/lib/codemod-apply";
import type { ReadinessCommandRunner } from "../../src/lib/operator-readiness";
import type { ReadinessCommand } from "../../src/lib/operator-readiness-types";
import type { Rule } from "../../src/lib/rule-declaration";
import { scan } from "../../src/lib/scan";
import { workspaceState } from "../../src/lib/state";
import { commitFixture } from "./commit-fixture";
import { copyFixture } from "./copy-fixture";

import type { ScanCacheSeeds } from "./scan-cache-seeds";

const FIXTURE = resolve(import.meta.dirname, "../lib/fixtures/deps");
export const READY = "packages/plans/src/foo.ts#PlanAlpha";
export const ALSO_READY = "packages/plans/src/bar.ts#PlanBeta";
export const PUBLISHABLE = "packages/plans-pub/src/index.ts#PlanPublic";
export const UNSUPPORTED = "packages/plans/src/index.ts#PlanDirectUsed";
export const UNPERMITTED = "packages/beta/src/index.ts#betaMetric";
export const RULES: Rule[] = [
  { effect: "permit", operator: "internalize", subject: "packages/plans" },
  { effect: "permit", operator: "internalize", subject: "packages/plans-pub" },
];
/** Wide enough that no line wraps, whatever the temporary path. */
export const UNWRAPPED = { width: 1000 };

export const pass: ReadinessCommandRunner = () => ({ exitCode: 0, output: "" });
export const refuse: ReadinessCommandRunner = () => {
  throw new Error("a baseline command ran");
};

/** Every file of a saved dataset, by path, with its text: what a published dataset holds. */
export function outputFiles(output: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), `${path}/`);
      } else {
        files[path] = readFileSync(join(directory, entry.name), "utf8");
      }
    }
  };
  walk(output, "");
  return files;
}

/** A wall-clock measurement, which every report names `…Ms` and no two runs share. */
const TIMING = /Ms$/;

/** A value without its wall-clock measurements, at any depth. */
function withoutTimings(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutTimings);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !TIMING.test(key))
      .map(([key, field]) => [key, withoutTimings(field)])
  );
}

/**
 * A dataset file as two scans of the same sources agree on it: without
 * wall-clock measurements anywhere, and the two manifests without what says
 * when and how a scan ran (its times, phases, and what it reused, cached, or
 * derived); everything else whole.
 */
export function withoutVolatile(
  file: string,
  text: string | undefined
): unknown {
  // A manifest's shape as far as the test strips it; other files pass through.
  const parsed = withoutTimings(JSON.parse(text ?? "null")) as Record<
    string,
    unknown
  > & {
    generation: Record<string, unknown>;
    snapshots: Record<string, unknown>[];
  };
  if (file === "manifest.json") {
    const {
      artifactsGenerated: _generated,
      artifactsReused: _reused,
      derived: _derived,
      finishedAt: _finished,
      packagesAnalyzed: _analyzed,
      packagesReused: _packagesReused,
      phases: _phases,
      startedAt: _started,
      ...generation
    } = parsed.generation;
    return { ...parsed, generatedAt: undefined, generation };
  }
  if (file === "history/manifest.json") {
    return {
      ...parsed,
      generatedAt: undefined,
      generation: undefined,
      snapshots: parsed.snapshots.map(
        ({ cached: _cached, ...snapshot }) => snapshot
      ),
    };
  }
  return parsed;
}

/** A journal an apply left, for the refusals that read it. */
export function journalFor(
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
 * of its packages. Every copy after the first of its kind starts from the
 * first's scan cache.
 */
export async function scannedCopy(
  seeds: ScanCacheSeeds,
  prefix: string,
  { git = true, history = false }: { git?: boolean; history?: boolean } = {}
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  // The caller removes the directory only once it has it back.
  try {
    const root = join(directory, "workspace");
    copyFixture(FIXTURE, root);
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
    mkdirSync(join(root, ".foundry/spyglass"), { recursive: true });
    writeFileSync(
      join(root, ".foundry/spyglass/rules.ts"),
      `export default { rules: ${JSON.stringify(RULES)} };\n`
    );
    if (git) {
      commitFixture(root);
    }
    const state = join(directory, "state");
    const { cache } = await workspaceState(root, state);
    await seeds.around(`history=${history}`, cache, () =>
      scan.workspace(root, { history, state })
    );
    return {
      directory,
      root,
      state,
      workspace: await workspaceState(root, state),
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

/** A fresh scanned copy, with the plan for READY authorized; `directories` collects it for removal. */
export async function plannedCopy(
  seeds: ScanCacheSeeds,
  directories: string[],
  options: { git?: boolean; history?: boolean } = {}
) {
  const copy = await scannedCopy(seeds, "spyglass-write-", options);
  directories.push(copy.directory);
  const site = resolveSite(READY);
  const authorized = await planSite(copy.root, site, {
    runner: pass,
    state: copy.state,
  });
  if (authorized.verdict.kind !== "authorized") {
    throw new Error(
      `the fixture's plan for READY should be authorized, not ${authorized.verdict.kind}`
    );
  }
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
export function afterTheWrite(
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
