import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { nativeRepositoryReader } from "./boundary";
import { assembleDataset } from "./dataset-assembly";
import { fileTransport, previousVisualization } from "./dataset-files";
import {
  DATASET_FILES,
  encodePackageFile,
  packageReportFile,
} from "./dataset-layout";
import { resolveDependencyGraph } from "./dependency-graph";
import { collectDependencyInventory } from "./dependency-inventory";
import { replaceDirectory } from "./directory-publication";
import { requireDeclared, workspaceRootName } from "./discovery-rules";
import type { InternalsProgressEvent } from "./internal-analysis";
import { writeInternals } from "./internal-analysis";
import type { PackageLocalReport } from "./package-local-types";
import type { CachedPackageMeta } from "./semantics-cache";
import {
  cacheStatistics,
  DEFAULT_SEMANTICS_CACHE,
  listCachedPackages,
  lookupPackage,
  readCachedPackage,
  readWorkspaceInputsMeta,
  refreshPackageMeta,
  removePackage,
  storePackage,
  storeWorkspaceInputsMeta,
} from "./semantics-cache";
import { discoverSemanticsUnits } from "./semantics-discover";
import {
  canonicalSemanticsText,
  listSemanticsFiles,
} from "./semantics-equivalence";
import type {
  PackageFingerprint,
  PackageLocalFingerprint,
  WorkspaceInputs,
} from "./semantics-fingerprint";
import {
  collectWorkspaceInputs,
  packageFingerprint,
  packageLocalFingerprint,
  startOfUtcDay,
  workspaceInputsHash,
} from "./semantics-fingerprint";
import type {
  SemanticsConfig,
  SemanticsGenerationError,
  SemanticsGenerationMode,
  SemanticsGenerationResult,
  SemanticsInvalidation,
  SemanticsInvalidationReason,
  SemanticsPhase,
  SemanticsPhaseTiming,
  SemanticsWorkspaceUnit,
} from "./semantics-types";
import { DEFAULT_CONFIGURATION } from "./spyglass-config";
import type { AnalysisProfile, SurfaceReport } from "./types";
import { CHILD_CWD, WORKER_RUNTIME, workerEntry } from "./worker-runtime";
import type { WorkspaceDerivationTiming } from "./workspace-derive-types";

// Materializes a static dataset from package-local analysis and workspace
// derivation. Incremental builds reuse fingerprinted reports and carry
// byte-identical artifacts forward before publishing the new tree.

/** Package-local analysis of one unit; reads nothing outside the package. */
export type SemanticsLocalAnalyzer = (
  unit: SemanticsWorkspaceUnit,
  context: { root: string }
) => Promise<PackageLocalReport>;

/** One workspace derivation over every local report, assembled into reports in the same order. */
export type SemanticsDeriver = (
  locals: PackageLocalReport[],
  context: { root: string; now: Date; profile?: AnalysisProfile }
) => Promise<{ reports: SurfaceReport[]; timing?: WorkspaceDerivationTiming }>;

export type SemanticsProgressEvent =
  | { kind: "phase"; phase: SemanticsPhase; detail?: string }
  /** The invalidation plan, emitted once fingerprints are known and before any analysis. */
  | { kind: "plan"; invalidations: SemanticsInvalidation[] }
  /**
   * One package's local analysis: `started` when its worker begins (its
   * `durationMs` is 0 and `done` is unchanged), then one of the other three.
   */
  | {
      kind: "unit";
      unit: string;
      status: "complete" | "failed" | "reused" | "started";
      durationMs: number;
      done: number;
      total: number;
      error?: string;
    }
  | InternalsProgressEvent;

export interface SemanticsGenerateOptions {
  analyzeLocal?: SemanticsLocalAnalyzer;
  /** Workspace-relative or absolute cache directory; written in both modes. */
  cache?: string;
  command?: string;
  concurrency?: number;
  /** The resolved configuration, which `scan` loads; never loaded here. Default: the plain defaults. */
  config?: SemanticsConfig;
  derive?: SemanticsDeriver;
  /** Fingerprint and look up the cache, then stop: no analysis, no output. */
  dryRun?: boolean;
  /** Stop at the first failed package, and publish nothing when any package failed. */
  failFast?: boolean;
  /**
   * Also derive each complete package's internals into the dataset. An
   * internals crash aborts the generation, with or without `failFast`.
   */
  internals?: boolean;
  /** `full` (default) analyzes every unit; `incremental` reuses cached reports. */
  mode?: SemanticsGenerationMode;
  /**
   * Shared clock for workspace derivation. Defaults to the start of the
   * current UTC day: history windows and `daysSinceLastChange` are measured
   * against it, so builds within one day share every input. Package-local
   * analysis never reads it.
   */
  now?: Date;
  onProgress?: (event: SemanticsProgressEvent) => void;
  /** Workspace-relative or absolute dataset directory. Default `.foundry/semantics`; `scan` passes the state directory's. */
  output?: string;
  /**
   * The dataset whose byte-identical artifacts are hardlinked into the new
   * one: by default the output itself. A scan staged beside the output, as
   * apply's is, names the published one.
   */
  previous?: string;
  root: string;
}

const DEFAULT_OUTPUT = ".foundry/semantics";

const execFileAsync = promisify(execFile);
const WORKER = workerEntry("semantics-worker");

/** Default local analyzer: one Bun worker per unit, report written and read back as JSON. */
export const spawnLocalAnalyzer: SemanticsLocalAnalyzer = async (
  unit,
  { root }
) => {
  const dir = mkdtempSync(join(tmpdir(), "semantics-worker-"));
  const out = join(dir, "local.json");
  try {
    await execFileAsync(
      WORKER_RUNTIME,
      [
        WORKER,
        "--stage",
        "local",
        "--root",
        resolve(root),
        "--target",
        unit.path,
        "--out",
        out,
      ],
      { cwd: CHILD_CWD, maxBuffer: 64 * 1024 * 1024 }
    );
    return JSON.parse(readFileSync(out, "utf8")) as PackageLocalReport;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

/**
 * Default deriver: one Bun worker holding the shared workspace program
 * for every unit at once, released by exit. Local reports travel by file.
 */
export const spawnDeriver: SemanticsDeriver = async (
  locals,
  { root, now, profile }
) => {
  const dir = mkdtempSync(join(tmpdir(), "semantics-derive-"));
  const out = join(dir, "reports");
  try {
    const files = locals.map((local, index) => {
      const file = join(dir, `local-${index}.json`);
      writeFileSync(file, JSON.stringify(local));
      return file;
    });
    const list = join(dir, "locals.json");
    writeFileSync(list, JSON.stringify(files));
    await execFileAsync(
      WORKER_RUNTIME,
      [
        WORKER,
        "--stage",
        "derive",
        "--root",
        resolve(root),
        "--locals",
        list,
        "--out",
        out,
        "--now",
        now.toISOString(),
        "--profile",
        profile ?? "full",
      ],
      { cwd: CHILD_CWD, maxBuffer: 64 * 1024 * 1024 }
    );
    const reports = locals.map((local) => {
      const id = local.package.name ?? local.package.path;
      return JSON.parse(
        readFileSync(join(out, `${encodePackageFile(id)}.json`), "utf8")
      ) as SurfaceReport;
    });
    const derivation = JSON.parse(
      readFileSync(join(out, "derivation.json"), "utf8")
    ) as { timing: WorkspaceDerivationTiming };
    return { reports, timing: derivation.timing };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

/**
 * Writes the new tree. An artifact whose bytes equal the previous dataset's
 * is hardlinked from there (copied when the filesystem refuses), so unchanged
 * files keep their inode and mtime and the swap stays atomic.
 */
class Writer {
  readonly files: { file: string; bytes: number; reused: boolean }[] = [];

  readonly dir: string;
  readonly previous: string | undefined;
  constructor(dir: string, previous: string | undefined) {
    this.dir = dir;
    this.previous = previous;
  }

  write(file: string, value: unknown): void {
    const target = join(this.dir, file);
    mkdirSync(dirname(target), { recursive: true });
    const text = Buffer.from(JSON.stringify(value));
    const reused = this.previous !== undefined && this.link(file, text, target);
    if (!reused) {
      writeFileSync(target, text);
    }
    this.files.push({ bytes: text.byteLength, file, reused });
  }

  private link(file: string, text: Buffer, target: string): boolean {
    const old = join(this.previous ?? "", file);
    let stat: Stats;
    try {
      stat = statSync(old);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size !== text.byteLength) {
      return false;
    }
    if (!readFileSync(old).equals(text)) {
      return false;
    }
    try {
      linkSync(old, target);
    } catch {
      copyFileSync(old, target);
    }
    return true;
  }
}

export async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await fn(items[index] as T, index);
      }
    }
  );
  await Promise.all(lanes);
  return results;
}

type Source = "analyzed" | "reused" | "unchanged";

interface UnitOutcome {
  error?: string;
  local?: PackageLocalReport;
  /** How the local report was obtained; `unchanged`: analyzed, equal to the cached one. */
  localSource?: Source;
  report?: SurfaceReport;
  /** How the assembled report was obtained; `unchanged`: derived, canonically equal to the cached one. */
  reportSource?: Source;
  unit: SemanticsWorkspaceUnit;
}

interface CacheSlot<F, T> {
  cached?: { meta: CachedPackageMeta; value?: T };
  fingerprint: F;
  invalidation: SemanticsInvalidation;
}

interface UnitPlan {
  local: CacheSlot<PackageLocalFingerprint, PackageLocalReport>;
  report: CacheSlot<PackageFingerprint, SurfaceReport>;
  unit: SemanticsWorkspaceUnit;
}

/** The first fingerprint component that moved, in dependency order. */
function componentCause(
  previous: Record<string, string>,
  next: Record<string, string>
): SemanticsInvalidationReason {
  for (const [component, cause] of [
    ["analysis", "analysis-changed"],
    ["config", "config-changed"],
    ["sources", "sources-changed"],
    ["evolution", "evolution-changed"],
    ["clock", "clock-changed"],
  ] as const) {
    if (component in next && previous[component] !== next[component]) {
      return cause;
    }
  }
  return "fingerprint-unchanged";
}

/** Inputs whose hash differs from the previous build's record, sorted. */
function changedWorkspaceInputs(
  previous: Record<string, string> | undefined,
  files: Map<string, string>
): string[] {
  if (previous === undefined) {
    return [];
  }
  const changed: string[] = [];
  for (const [file, hash] of files) {
    if (previous[file] !== hash) {
      changed.push(file);
    }
  }
  for (const file of Object.keys(previous)) {
    if (!files.has(file)) {
      changed.push(file);
    }
  }
  return changed.sort();
}

interface SlotContext {
  cacheDir: string;
  /** Workspace inputs whose hash moved since the previous build. */
  changedWorkspace: string[];
  mode: SemanticsGenerationMode;
  previousInputs: Record<string, string> | undefined;
}

/**
 * One cache slot's plan: reuse when the entry is valid under the current
 * fingerprint, otherwise recompute with the first cause that explains it.
 * `changed` names the inputs that moved — the package's own files for a
 * local slot, the workspace's for a report slot.
 */
function planSlot<
  F extends { combined: string; components: Record<string, string> },
  T,
>(
  unit: SemanticsWorkspaceUnit,
  kind: "package-local" | "package-report",
  fingerprint: F,
  changed: string[],
  context: SlotContext
): CacheSlot<F, T> {
  const base = { fingerprint: fingerprint.combined, id: unit.id, kind };
  if (context.mode === "full") {
    return {
      fingerprint,
      invalidation: {
        ...base,
        reason: { cause: "full-rebuild", type: "direct" },
        status: "recompute",
      },
    };
  }
  const lookup = lookupPackage<T>(
    context.cacheDir,
    unit.id,
    kind,
    fingerprint.combined
  );
  if (lookup.hit) {
    return {
      cached: { meta: lookup.meta, value: lookup.value },
      fingerprint,
      invalidation: {
        ...base,
        reason: { cause: "fingerprint-unchanged", type: "direct" },
        status: "reuse",
      },
    };
  }
  let cause: SemanticsInvalidationReason = "cache-missing";
  let changedFiles: string[] | undefined;
  if (lookup.reason === "fingerprint-changed") {
    cause =
      lookup.meta === undefined
        ? "cache-corrupt"
        : componentCause(lookup.meta.components, fingerprint.components);
    if (cause === "sources-changed") {
      changedFiles = changed;
    }
  } else if (lookup.reason !== "cache-missing") {
    cause = lookup.reason;
  } else if (
    context.previousInputs !== undefined &&
    context.previousInputs[unit.manifestPath] === undefined
  ) {
    cause = "package-added";
  }
  return {
    fingerprint,
    invalidation: {
      ...base,
      reason: {
        cause,
        type: "direct",
        ...(changedFiles !== undefined && { changed: changedFiles }),
      },
      status: "recompute",
    },
    ...(lookup.meta !== undefined && { cached: { meta: lookup.meta } }),
  };
}

function planUnits(
  root: string,
  units: SemanticsWorkspaceUnit[],
  inputs: WorkspaceInputs,
  context: Omit<SlotContext, "changedWorkspace">
): UnitPlan[] {
  const changedWorkspace = changedWorkspaceInputs(
    context.previousInputs,
    inputs.files
  );
  const slots = { ...context, changedWorkspace };
  return units.map((unit): UnitPlan => {
    const local = packageLocalFingerprint(root, unit, inputs.files);
    const changedLocal = changedWorkspace.filter((file) =>
      local.files.has(file)
    );
    return {
      local: planSlot(unit, "package-local", local, changedLocal, slots),
      report: planSlot(
        unit,
        "package-report",
        packageFingerprint(inputs, unit),
        changedWorkspace,
        slots
      ),
      unit,
    };
  });
}

const WORKSPACE_STAGES = [
  "workspaceDerivation",
  "workspaceIngestion",
  "workspaceIntelligence",
  "workspaceProjection",
  "materialization",
] as const;

/** Under `failFast`, before anything is written: a package without a report fails the generation. */
function failOnUnreported(outcomes: readonly UnitOutcome[]): void {
  const failed = outcomes.flatMap((o) =>
    o.report === undefined ? [`${o.unit.id} (${o.error})`] : []
  );
  if (failed.length > 0) {
    throw new Error(`Packages failed analysis: ${failed.join(", ")}`);
  }
}

export function rootName(root: string): string | undefined {
  return workspaceRootName(nativeRepositoryReader, root);
}

export async function generateSemantics(
  options: SemanticsGenerateOptions
): Promise<SemanticsGenerationResult> {
  const root = realpathSync(resolve(options.root));
  const {
    progress,
    config,
    dryRun,
    now,
    mode,
    concurrency,
    analyzeLocal,
    derive,
  } = collectConfig(options);
  const startedAt = new Date();
  const started = performance.now();
  const phases: SemanticsPhaseTiming[] = [];
  const errors: SemanticsGenerationError[] = [];
  const timed = async <T>(
    name: SemanticsPhase,
    detail: string | undefined,
    run: () => Promise<T> | T
  ): Promise<T> => {
    progress({
      kind: "phase",
      phase: name,
      ...(detail !== undefined && { detail }),
    });
    const at = performance.now();
    try {
      return await run();
    } finally {
      phases.push({ durationMs: Math.round(performance.now() - at), name });
    }
  };

  const output = resolve(root, options.output ?? DEFAULT_OUTPUT);
  const cacheDir = resolve(root, options.cache ?? DEFAULT_SEMANTICS_CACHE);
  const tmp = `${output}.tmp-${process.pid}`;
  const reuseFrom = resolve(root, options.previous ?? output);
  const previous = existsSync(reuseFrom) ? reuseFrom : undefined;
  if (!dryRun) {
    rmSync(tmp, { force: true, recursive: true });
    mkdirSync(tmp, { recursive: true });
  }
  const writer = new Writer(tmp, previous);

  try {
    const discovery = requireDeclared(
      root,
      await timed("discover", undefined, () =>
        discoverSemanticsUnits(root, config)
      )
    );

    const previousInputs = readWorkspaceInputsMeta(cacheDir)?.files;
    const { inputs, plans } = await timed(
      "fingerprint",
      undefined,
      async () => {
        const collected = await collectWorkspaceInputs({
          config,
          now,
          root,
          units: discovery.units,
        });
        return {
          inputs: collected,
          plans: planUnits(root, discovery.units, collected, {
            cacheDir,
            mode,
            previousInputs,
          }),
        };
      }
    );
    const invalidations: SemanticsInvalidation[] = [
      ...plans.map((plan) => plan.local.invalidation),
      ...plans.map((plan) => plan.report.invalidation),
    ];
    const discovered = new Set(discovery.units.map((unit) => unit.id));
    const visitId = (
      currentDiscovered: Set<string>,
      currentInvalidations2: SemanticsInvalidation[]
    ) => {
      for (const id of new Set([
        ...listCachedPackages(cacheDir, "package-local"),
        ...listCachedPackages(cacheDir, "package-report"),
      ])) {
        if (currentDiscovered.has(id)) {
          continue;
        }
        currentInvalidations2.push({
          id,
          kind: "package-report",
          reason: { cause: "package-removed", type: "direct" },
          status: "remove",
        });
        if (!dryRun) {
          removePackage(cacheDir, id);
        }
      }
    };
    visitId(discovered, invalidations);
    const recomputeLocal = plans.filter(
      (p) => p.local.invalidation.status === "recompute"
    );
    const recomputeReports = plans.filter(
      (p) => p.report.invalidation.status === "recompute"
    );
    // Derivation reads every package, so one invalidated report derives all.
    const visitStage = (
      currentInvalidations: SemanticsInvalidation[],
      currentRecomputeLocal: UnitPlan[],
      currentRecomputeReports: UnitPlan[],
      currentDeriving: boolean
    ) => {
      for (const stage of WORKSPACE_STAGES) {
        currentInvalidations.push({
          id: stage,
          kind: "workspace-stage",
          reason: {
            source: (stage === "workspaceDerivation"
              ? currentRecomputeLocal
              : currentRecomputeReports
            ).map((p) => p.unit.id),
            type: "dependency",
          },
          status:
            stage === "workspaceDerivation" && !currentDeriving
              ? "reuse"
              : "recompute",
        });
      }
    };
    const deriving = recomputeReports.length > 0;
    visitStage(invalidations, recomputeLocal, recomputeReports, deriving);
    progress({ invalidations, kind: "plan" });

    if (dryRun) {
      const stats = cacheStatistics(cacheDir);
      return {
        artifacts: { generated: 0, removed: 0, reused: 0 },
        bytes: 0,
        cache: { dir: cacheDir, ...stats },
        concepts: 0,
        coverage: "partial",
        dryRun: true,
        durationMs: Math.round(performance.now() - started),
        errors,
        files: 0,
        invalidations,
        largest: [],
        manifest: join(output, DATASET_FILES.manifest),
        missingPackages: [],
        mode,
        modules: 0,
        output,
        packages: {
          analyzed: recomputeLocal.length,
          complete: 0,
          discovered: discovery.units.length,
          failed: 0,
          reused: plans.length - recomputeLocal.length,
          skipped: discovery.skipped.length,
          unchanged: 0,
        },
        phases,
        reports: {
          derived: deriving ? plans.length : 0,
          reused: deriving ? 0 : plans.length,
          unchanged: 0,
        },
      };
    }

    const outcomes = await timed(
      "analyze",
      `${recomputeLocal.length} of ${plans.length} local reports`,
      async () => {
        const results = new Map<string, UnitOutcome>();
        let done = 0;
        let aborted = false;
        const total = plans.length;
        for (const plan of plans) {
          if (plan.local.invalidation.status !== "reuse") {
            continue;
          }
          const local = plan.local.cached?.value;
          if (local === undefined) {
            continue;
          }
          results.set(plan.unit.id, {
            local,
            localSource: "reused",
            unit: plan.unit,
          });
          done += 1;
          progress({
            done,
            durationMs: 0,
            kind: "unit",
            status: "reused",
            total,
            unit: plan.unit.id,
          });
        }
        await mapBounded(recomputeLocal, concurrency, async (plan) => {
          const { unit } = plan;
          if (aborted) {
            results.set(unit.id, {
              error: "skipped after an earlier failure",
              unit,
            });
            return;
          }
          const at = performance.now();
          progress({
            done,
            durationMs: 0,
            kind: "unit",
            status: "started",
            total,
            unit: unit.id,
          });
          try {
            const fresh = await analyzeLocal(unit, { root });
            let local = fresh;
            let localSource: Source = "analyzed";
            const cachedLocal =
              mode === "incremental" && plan.local.cached !== undefined
                ? readCachedPackage(cacheDir, unit.id, "package-local")
                : undefined;
            if (
              cachedLocal !== undefined &&
              plan.local.cached !== undefined &&
              JSON.stringify(cachedLocal) === JSON.stringify(fresh)
            ) {
              local = cachedLocal;
              localSource = "unchanged";
              refreshPackageMeta(cacheDir, plan.local.cached.meta, {
                components: plan.local.fingerprint.components,
                fingerprint: plan.local.fingerprint.combined,
              });
            } else {
              storePackage(cacheDir, {
                analyzedAt: new Date().toISOString(),
                components: plan.local.fingerprint.components,
                fingerprint: plan.local.fingerprint.combined,
                id: unit.id,
                kind: "package-local",
                path: unit.path,
                value: local,
              });
            }
            done += 1;
            progress({
              done,
              durationMs: Math.round(performance.now() - at),
              kind: "unit",
              status: "complete",
              total,
              unit: unit.id,
            });
            results.set(unit.id, { local, localSource, unit });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            done += 1;
            errors.push({ message, phase: "analyze", unit: unit.id });
            progress({
              done,
              durationMs: Math.round(performance.now() - at),
              error: message,
              kind: "unit",
              status: "failed",
              total,
              unit: unit.id,
            });
            if (options.failFast === true) {
              aborted = true;
              throw error;
            }
            results.set(unit.id, { error: message, unit });
          }
        });
        return plans.map(
          (plan): UnitOutcome =>
            results.get(plan.unit.id) ?? {
              error: "skipped after an earlier failure",
              unit: plan.unit,
            }
        );
      }
    );

    const planById = new Map(plans.map((plan) => [plan.unit.id, plan]));
    let derivationTiming: WorkspaceDerivationTiming | undefined;
    const failDerivation = (outcome: UnitOutcome, message: string): void => {
      outcome.error = message;
      errors.push({ message, phase: "derive", unit: outcome.unit.id });
    };
    await timed(
      "derive",
      deriving
        ? `${outcomes.filter((o) => o.local !== undefined).length} local reports`
        : "every assembled report reused",
      async () => {
        if (!deriving) {
          for (const outcome of outcomes) {
            const report = planById.get(outcome.unit.id)?.report.cached?.value;
            if (outcome.local === undefined) {
              continue;
            }
            if (report === undefined) {
              failDerivation(outcome, "The cached report is missing.");
              continue;
            }
            outcome.report = report;
            outcome.reportSource = "reused";
            writer.write(packageReportFile(outcome.unit.id), report);
          }
          return;
        }
        const ready = outcomes.filter(
          (outcome): outcome is UnitOutcome & { local: PackageLocalReport } =>
            outcome.local !== undefined
        );
        if (ready.length === 0) {
          return;
        }
        const derived = await derive(
          ready.map((outcome) => outcome.local),
          { now, root }
        );
        derivationTiming = derived.timing;
        ready.forEach((outcome, index) => {
          const fresh = derived.reports[index];
          const plan = planById.get(outcome.unit.id);
          if (fresh === undefined || plan === undefined) {
            failDerivation(outcome, "Derivation produced no report.");
            return;
          }
          const { unit } = outcome;
          let report = fresh;
          let reportSource: Source = "analyzed";
          const cachedReport =
            mode === "incremental" && plan.report.cached !== undefined
              ? readCachedPackage(cacheDir, unit.id, "package-report")
              : undefined;
          if (
            cachedReport !== undefined &&
            plan.report.cached !== undefined &&
            canonicalSemanticsText(packageReportFile(unit.id), cachedReport) ===
              canonicalSemanticsText(packageReportFile(unit.id), fresh)
          ) {
            report = cachedReport;
            reportSource = "unchanged";
            refreshPackageMeta(cacheDir, plan.report.cached.meta, {
              components: plan.report.fingerprint.components,
              fingerprint: plan.report.fingerprint.combined,
            });
          } else {
            storePackage(cacheDir, {
              analyzedAt: new Date().toISOString(),
              components: plan.report.fingerprint.components,
              fingerprint: plan.report.fingerprint.combined,
              id: unit.id,
              kind: "package-report",
              path: unit.path,
              value: report,
            });
          }
          outcome.report = report;
          outcome.reportSource = reportSource;
          writer.write(packageReportFile(unit.id), report);
        });
      }
    );
    if (derivationTiming !== undefined) {
      const timing = derivationTiming;
      progress({
        detail: `program ${timing.projectMs}ms, references ${timing.referencesMs}ms, cruise ${timing.cruiseMs}ms, history ${timing.historyMs}ms, concepts ${timing.conceptsMs}ms, overlap index ${timing.overlapIndexMs}ms, packages ${timing.packagesMs}ms`,
        kind: "phase",
        phase: "derive",
      });
    }

    if (options.failFast === true) {
      failOnUnreported(outcomes);
    }

    const count = (
      pick: (o: UnitOutcome) => Source | undefined,
      ...sources: Source[]
    ): number =>
      outcomes.filter((o) => {
        const source = pick(o);
        return source !== undefined && sources.includes(source);
      }).length;
    const analyzed = count((o) => o.localSource, "analyzed", "unchanged");
    const unchanged = count((o) => o.localSource, "unchanged");
    const reused = count((o) => o.localSource, "reused");
    const reportsDerived = count(
      (o) => o.reportSource,
      "analyzed",
      "unchanged"
    );
    const reportsUnchanged = count((o) => o.reportSource, "unchanged");
    const reportsReused = count((o) => o.reportSource, "reused");
    const { concepts, manifest, modules, packages, workspace } =
      await assembleDataset(
        {
          command: options.command ?? "generateSemantics",
          concurrency,
          derived: deriving,
          discovery,
          ...(options.internals === true && {
            internals: (assembled, write) =>
              writeInternals(assembled, progress, write),
          }),
          inputs: { config: inputs.config, hash: workspaceInputsHash(inputs) },
          inventory: () => {
            const inventory = collectDependencyInventory(root, discovery);
            inventory.graph = resolveDependencyGraph(root, inventory);
            return inventory;
          },
          mode,
          outcomes,
          packagesAnalyzed: analyzed,
          packagesReused: reused,
          phase: (name, run) => timed(name, undefined, run),
          phases,
          previousVisualization: () => previousVisualization(previous),
          root,
          settings: { domains: config.domains, rules: config.rules },
          startedAt,
          workspaceName: rootName(root),
        },
        {
          files: writer.files,
          read: fileTransport(tmp),
          write: (file, value) => writer.write(file, value),
        }
      );
    const failures = packages.filter((p) => p.status === "failed").length;

    const written = new Set(writer.files.map((f) => f.file));
    const removed =
      previous === undefined
        ? 0
        : listSemanticsFiles(previous).filter((f) => !written.has(f)).length;
    replaceDirectory(tmp, output);
    // Recorded only once the dataset is published, so an interrupted build
    // leaves the previous record and `--explain` still names what changed.
    storeWorkspaceInputsMeta(cacheDir, inputs.files);

    const bytes = writer.files.reduce((sum, f) => sum + f.bytes, 0);
    const { artifactsReused } = manifest.generation;
    return {
      artifacts: {
        generated: writer.files.length - artifactsReused,
        removed,
        reused: artifactsReused,
      },
      bytes,
      cache: { dir: cacheDir, ...cacheStatistics(cacheDir) },
      concepts: concepts.concepts.length,
      coverage: manifest.coverage,
      dryRun: false,
      durationMs: Math.round(performance.now() - started),
      errors,
      files: writer.files.length,
      invalidations,
      largest: [...writer.files]
        .sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file))
        .slice(0, 5),
      manifest: join(output, DATASET_FILES.manifest),
      missingPackages: workspace.ingestion.coverage.missingPackages,
      mode,
      modules: modules.length,
      output,
      packages: {
        analyzed,
        complete: packages.length - failures,
        discovered: discovery.units.length,
        failed: failures,
        reused,
        skipped: discovery.skipped.length,
        unchanged,
      },
      phases,
      reports: {
        derived: reportsDerived,
        reused: reportsReused,
        unchanged: reportsUnchanged,
      },
    };
  } catch (error) {
    rmSync(tmp, { force: true, recursive: true });
    throw error;
  }
}

function collectConfig(options: SemanticsGenerateOptions) {
  const config = options.config ?? DEFAULT_CONFIGURATION;
  const now = options.now ?? startOfUtcDay(new Date());
  const mode = options.mode ?? "full";
  const dryRun = options.dryRun === true;
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const analyzeLocal = options.analyzeLocal ?? spawnLocalAnalyzer;
  const derive = options.derive ?? spawnDeriver;
  const progress = options.onProgress ?? (() => undefined);
  return {
    analyzeLocal,
    concurrency,
    config,
    derive,
    dryRun,
    mode,
    now,
    progress,
  };
}
