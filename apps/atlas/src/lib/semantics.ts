import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  ANALYSIS_POLICY_VERSION,
  WORKSPACE_INTELLIGENCE_POLICY_VERSION,
} from "./config";
import type { PackageLocalReport } from "./package-local-types";
import type { CachedPackageMeta } from "./semantics-cache";
import {
  acquireCacheLock,
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
import {
  discoverSemanticsUnits,
  loadSemanticsConfig,
} from "./semantics-discover";
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
} from "./semantics-fingerprint";
import type {
  SemanticsConceptIndex,
  SemanticsConfig,
  SemanticsCouplingIndex,
  SemanticsDiscovery,
  SemanticsGenerationError,
  SemanticsGenerationMode,
  SemanticsGenerationResult,
  SemanticsInvalidation,
  SemanticsInvalidationReason,
  SemanticsManifest,
  SemanticsManifestPackage,
  SemanticsModuleEdge,
  SemanticsModuleEdgeShard,
  SemanticsModuleIndex,
  SemanticsModuleIndexEntry,
  SemanticsModuleRecord,
  SemanticsModuleShard,
  SemanticsPhase,
  SemanticsPhaseTiming,
  SemanticsWorkspaceUnit,
} from "./semantics-types";
import { SEMANTICS_DATASET_SCHEMA_VERSION } from "./semantics-types";
import type { AnalysisProfile, SurfaceReport } from "./types";
import type { WorkspaceDerivationTiming } from "./workspace-derive-types";
import { ingestWorkspaceReports } from "./workspace-ingest";
import { analyzeWorkspace } from "./workspace-intelligence";
import {
  createWorkspaceProjectionContext,
  listWorkspacePatterns,
  projectWorkspaceOverview,
  projectWorkspacePackage,
  workspaceProjectionManifest,
} from "./workspace-projection";
import type { WorkspaceProjectionContext } from "./workspace-projection-types";
import { WORKSPACE_PROJECTION_SCHEMA_VERSION } from "./workspace-projection-types";
import {
  listConceptDirections,
  projectWorkspaceGraph,
  projectWorkspaceMatrix,
} from "./workspace-projection-views";
import type { WorkspaceReport } from "./workspace-types";
import { WORKSPACE_SCHEMA_VERSION } from "./workspace-types";

// V12.0 materializer. Orchestrates the canonical analyzers — package
// analysis (in a worker process per unit), V9 ingestion and intelligence,
// V9.4 projections — and writes the results as one static dataset. No
// analysis logic lives here; every number is copied from a canonical model.
//
// V12.5 adds incremental materialization: cached results are reused from
// `.foundry/cache/semantics/` when their input fingerprint is unchanged,
// workspace intelligence is always recomputed (milliseconds), and artifacts
// byte-identical to the previous dataset are carried into the new tree
// instead of rewritten. The dataset is still published by one atomic swap.
//
// V12.6 splits package analysis in two. Package-local reports are analyzed
// per unit (a worker each, keyed by the unit's own sources) and cached;
// workspace derivation then runs once for every unit in one worker holding
// the shared program, and the assembled reports are cached under the
// workspace fingerprint. A localized source edit re-analyzes one package
// locally and derives the workspace once; a build with nothing changed
// reuses every assembled report and never builds a program.

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
  | {
      kind: "unit";
      unit: string;
      status: "complete" | "failed" | "reused";
      durationMs: number;
      done: number;
      total: number;
      error?: string;
    };

export interface SemanticsGenerateOptions {
  analyzeLocal?: SemanticsLocalAnalyzer;
  /** Repository-relative cache directory; written in both modes. */
  cache?: string;
  command?: string;
  concurrency?: number;
  config?: SemanticsConfig;
  derive?: SemanticsDeriver;
  /** Fingerprint and look up the cache, then stop: no analysis, no output. */
  dryRun?: boolean;
  failFast?: boolean;
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
  root: string;
}

const execFileAsync = promisify(execFile);
const WORKER = path.join(
  import.meta.dirname,
  import.meta.filename.endsWith(".ts")
    ? "semantics-worker.ts"
    : "semantics-worker.js"
);

/** Default local analyzer: one `bun` worker per unit, report written and read back as JSON. */
export const spawnLocalAnalyzer: SemanticsLocalAnalyzer = async (
  unit,
  { root }
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semantics-worker-"));
  const out = path.join(dir, "local.json");
  try {
    await execFileAsync(
      "bun",
      [
        WORKER,
        "--stage",
        "local",
        "--root",
        root,
        "--target",
        unit.path,
        "--out",
        out,
      ],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 }
    );
    return JSON.parse(fs.readFileSync(out, "utf8")) as PackageLocalReport;
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
};

/**
 * Default deriver: one `bun` worker holding the shared workspace program
 * for every unit at once, released by exit. Local reports travel by file.
 */
export const spawnDeriver: SemanticsDeriver = async (
  locals,
  { root, now, profile }
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semantics-derive-"));
  const out = path.join(dir, "reports");
  try {
    const files = locals.map((local, index) => {
      const file = path.join(dir, `local-${index}.json`);
      fs.writeFileSync(file, JSON.stringify(local));
      return file;
    });
    const list = path.join(dir, "locals.json");
    fs.writeFileSync(list, JSON.stringify(files));
    await execFileAsync(
      "bun",
      [
        WORKER,
        "--stage",
        "derive",
        "--root",
        root,
        "--locals",
        list,
        "--out",
        out,
        "--now",
        now.toISOString(),
        "--profile",
        profile ?? "full",
      ],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 }
    );
    const reports = locals.map((local) => {
      const id = local.package.name ?? local.package.path;
      return JSON.parse(
        fs.readFileSync(path.join(out, `${encodePackageFile(id)}.json`), "utf8")
      ) as SurfaceReport;
    });
    const derivation = JSON.parse(
      fs.readFileSync(path.join(out, "derivation.json"), "utf8")
    ) as { timing: WorkspaceDerivationTiming };
    return { reports, timing: derivation.timing };
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
};

/** `@foundry/db` → `@foundry__db`; reversible because npm names never contain `__`. */
export function encodePackageFile(id: string): string {
  return id.replace(/\//g, "__");
}

export function decodePackageFile(file: string): string {
  return file.replace(/__/g, "/");
}

const FILES = {
  conceptIndex: "concepts/index.json",
  couplings: "history/couplings.json",
  manifest: "manifest.json",
  moduleIndex: "modules/index.json",
  projections: {
    behaviorFlow: "projections/behavior-flow.json",
    boundaries: "projections/boundaries.json",
    dependencyGraph: "projections/dependency-graph.json",
    directions: "projections/directions.json",
    implementationFlow: "projections/implementation-flow.json",
    manifest: "projections/manifest.json",
    overview: "projections/overview.json",
    packageRoles: "projections/package-roles.json",
    patterns: "projections/patterns.json",
  },
  workspace: "workspace.json",
} as const;

function reportFile(id: string): string {
  return `packages/${encodePackageFile(id)}.json`;
}

function projectionFile(id: string): string {
  return `packages/${encodePackageFile(id)}.projection.json`;
}

function shardFile(id: string): string {
  return `modules/${encodePackageFile(id)}.json`;
}

function edgeShardFile(id: string): string {
  return `modules/edges/${encodePackageFile(id)}.json`;
}

/**
 * Writes the new tree. An artifact whose bytes equal the previous dataset's
 * is hardlinked from there (copied when the filesystem refuses), so unchanged
 * files keep their inode and mtime and the swap stays atomic.
 */
class Writer {
  readonly files: { file: string; bytes: number; reused: boolean }[] = [];

  constructor(
    readonly dir: string,
    readonly previous: string | undefined
  ) {}

  write(file: string, value: unknown): void {
    const target = path.join(this.dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const text = Buffer.from(JSON.stringify(value));
    const reused = this.previous !== undefined && this.link(file, text, target);
    if (!reused) {
      fs.writeFileSync(target, text);
    }
    this.files.push({ bytes: text.byteLength, file, reused });
  }

  private link(file: string, text: Buffer, target: string): boolean {
    const old = path.join(this.previous ?? "", file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(old);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size !== text.byteLength) {
      return false;
    }
    if (!fs.readFileSync(old).equals(text)) {
      return false;
    }
    try {
      fs.linkSync(old, target);
    } catch {
      fs.copyFileSync(old, target);
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
        const index = next++;
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

// ---------------------------------------------------------------------------
// MODULE RECORDS

export type ConceptRole = keyof SemanticsModuleRecord["concepts"];

/** Concept ids per role per module file, read from the canonical package reports. */
export function moduleConceptRoles(
  reports: SurfaceReport[]
): Map<string, Record<ConceptRole, Set<string>>> {
  const roles = new Map<string, Record<ConceptRole, Set<string>>>();
  const add = (file: string, role: ConceptRole, concept: string): void => {
    let entry = roles.get(file);
    if (entry === undefined) {
      entry = {
        behavior: new Set(),
        conversion: new Set(),
        declared: new Set(),
        implementation: new Set(),
        representation: new Set(),
        usage: new Set(),
      };
      roles.set(file, entry);
    }
    entry[role].add(concept);
  };
  for (const report of reports) {
    for (const family of report.conceptInventory.families) {
      const id = family.seed.id;
      add(family.seed.declaration.file, "declared", id);
      for (const rep of family.representations) {
        add(
          rep.file,
          rep.relationship === "implementation"
            ? "implementation"
            : "representation",
          id
        );
      }
      for (const evidence of family.evidence) {
        if (
          evidence.kind !== "declaration" &&
          evidence.kind !== "implements" &&
          evidence.kind !== "extends" &&
          evidence.kind !== "alias"
        ) {
          add(evidence.file, "usage", id);
        }
      }
    }
    for (const locality of report.conceptBehavioralLocality.concepts) {
      for (const module of locality.behavior.byModule) {
        add(module.module, "behavior", locality.concept.id);
      }
    }
    for (const candidate of report.conceptOverlap.candidates) {
      for (const conversion of candidate.conversions) {
        add(conversion.file, "conversion", candidate.left.id);
        add(conversion.file, "conversion", candidate.right.id);
      }
    }
  }
  return roles;
}

function sortedList(values: Set<string> | undefined): string[] {
  return values === undefined ? [] : [...values].sort();
}

function buildModuleRecords(
  workspace: WorkspaceReport,
  reports: SurfaceReport[]
): SemanticsModuleRecord[] {
  const graph = workspace.intelligence?.graph;
  const analysis = new Map(
    (graph?.modules ?? []).map((module) => [module.module, module])
  );
  const roles = moduleConceptRoles(reports);
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of workspace.graph.moduleEdges) {
    (
      outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)
    )?.push(edge.to);
    (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to))?.push(
      edge.from
    );
  }
  const churn = new Map(workspace.evolution.churn.map((c) => [c.file, c]));
  const hotspots = new Map(
    workspace.evolution.hotspots.map((h) => [h.file, h])
  );
  const couplings = new Map<string, string[]>();
  for (const pair of workspace.evolution.couplings) {
    for (const file of [pair.left, pair.right]) {
      (couplings.get(file) ?? couplings.set(file, []).get(file))?.push(pair.id);
    }
  }
  const analyzed = new Set(
    workspace.packages.packages.filter((p) => p.analyzed).map((p) => p.id)
  );
  return workspace.graph.modules
    .flatMap((module) =>
      module.package === undefined
        ? []
        : [{ ...module, package: module.package }]
    )
    .map((module): SemanticsModuleRecord => {
      const pkg = module.package;
      const facts = analysis.get(module.id);
      const conceptRoles = roles.get(module.id);
      const fileChurn = churn.get(module.id);
      const hotspot = hotspots.get(module.id);
      const cautions: string[] = [];
      if (!analyzed.has(pkg)) {
        cautions.push("package-not-analyzed");
      }
      if (module.gravity === undefined) {
        cautions.push("gravity-unobserved");
      }
      if (fileChurn === undefined) {
        cautions.push("history-unavailable");
      }
      return {
        id: module.id,
        package: pkg,
        path: module.id,
        ...(module.role !== undefined && { role: module.role.kind }),
        ...(module.fileKind !== undefined && { fileKind: module.fileKind }),
        ...(module.gravity !== undefined && { gravity: module.gravity }),
        ...(facts !== undefined && {
          graph: {
            cycle: facts.cycle,
            fanIn: facts.direct.fanIn,
            fanOut: facts.direct.fanOut,
            layer: facts.layer,
          },
        }),
        concepts: {
          behavior: sortedList(conceptRoles?.behavior),
          conversion: sortedList(conceptRoles?.conversion),
          declared: sortedList(conceptRoles?.declared),
          implementation: sortedList(conceptRoles?.implementation),
          representation: sortedList(conceptRoles?.representation),
          usage: sortedList(conceptRoles?.usage),
        },
        dependencies: {
          incoming: [...(incoming.get(module.id) ?? [])].sort(),
          outgoing: [...(outgoing.get(module.id) ?? [])].sort(),
        },
        ...(fileChurn !== undefined && {
          history: {
            authors: fileChurn.authors,
            commits: fileChurn.commits,
            linesChanged: fileChurn.linesChanged,
            ...(fileChurn.lastChangedAt !== undefined && {
              lastChangedAt: fileChurn.lastChangedAt,
            }),
            couplings: [...(couplings.get(module.id) ?? [])].sort(),
            hotspot: hotspot !== undefined,
            hotspotSignals: hotspot === undefined ? [] : [...hotspot.signals],
          },
        }),
        cautions,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildConceptIndex(workspace: WorkspaceReport): SemanticsConceptIndex {
  const placements = workspace.intelligence?.concepts?.concepts ?? [];
  return {
    concepts: placements
      .map((placement) => ({
        centers: {
          ...(placement.centers?.semantic !== undefined && {
            semantic: placement.centers.semantic,
          }),
          ...(placement.centers?.representation !== undefined && {
            representation: placement.centers.representation,
          }),
          ...(placement.centers?.usage !== undefined && {
            usage: placement.centers.usage,
          }),
          ...(placement.centers?.behavior !== undefined && {
            behavior: placement.centers.behavior,
          }),
        },
        coverage: placement.coverage,
        file: placement.concept.file,
        id: placement.concept.id,
        kind: placement.concept.kind,
        name: placement.concept.name,
        package: placement.concept.package,
        packages: placement.presence.packages,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    schemaVersion: SEMANTICS_DATASET_SCHEMA_VERSION,
  };
}

/**
 * Directed module edges grouped by the package owning the source module.
 * Intra-package edges come from each package report's own measurement;
 * cross-package edges from the merged workspace graph, so both perspectives
 * of a boundary collapse to one edge.
 */
function buildModuleEdgeShards(
  workspace: WorkspaceReport,
  reports: SurfaceReport[]
): SemanticsModuleEdgeShard[] {
  const byPackage = new Map<string, SemanticsModuleEdge[]>();
  const push = (pkg: string, edge: SemanticsModuleEdge): void => {
    (byPackage.get(pkg) ?? byPackage.set(pkg, []).get(pkg))?.push(edge);
  };
  for (const report of reports) {
    const pkg = report.target.name ?? report.target.path;
    for (const edge of report.dependencyGravity.internalEdges) {
      push(pkg, {
        id: `${edge.fromFile}→${edge.toFile}`,
        relation: "dependency",
        scope: "intra-package",
        source: edge.fromFile,
        target: edge.toFile,
        ...(edge.typeOnly !== undefined && { typeOnly: edge.typeOnly }),
      });
    }
  }
  for (const edge of workspace.graph.moduleEdges) {
    push(edge.fromPackage, {
      id: edge.id,
      relation: "dependency",
      scope: "cross-package",
      source: edge.from,
      target: edge.to,
      ...(edge.typeOnly !== undefined && { typeOnly: edge.typeOnly }),
    });
  }
  return [...byPackage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, edges]) => ({
      edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
      package: pkg,
    }));
}

function buildCouplingIndex(
  workspace: WorkspaceReport
): SemanticsCouplingIndex {
  return {
    couplings: workspace.evolution.couplings.map((pair) => ({
      coChangeCommits: pair.coChangeCommits,
      id: pair.id,
      jaccard: pair.jaccard,
      left: pair.left,
      leftCommits: pair.leftCommits,
      leftConditional: pair.leftConditional,
      leftPackage: pair.leftPackage,
      right: pair.right,
      rightCommits: pair.rightCommits,
      rightConditional: pair.rightConditional,
      rightPackage: pair.rightPackage,
      scope: pair.scope,
      ...(pair.lastCoChangedAt !== undefined && {
        lastCoChangedAt: pair.lastCoChangedAt,
      }),
    })),
    schemaVersion: SEMANTICS_DATASET_SCHEMA_VERSION,
  };
}

// ---------------------------------------------------------------------------
// GENERATION

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
    ["history", "history-changed"],
    ["clock", "clock-changed"],
  ] as const) {
    if (component in next && previous[component] !== next[component]) {
      return cause;
    }
  }
  return "fingerprint-unchanged";
}

/** Inputs whose hash differs from the previous build's record, sorted. */
export function changedWorkspaceInputs(
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

export function rootName(root: string): string | undefined {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    name?: unknown;
  };
  return typeof parsed.name === "string" ? parsed.name : undefined;
}

/** Swap `tmp` into place; the previous directory survives if the rename fails. */
export function replaceDirectory(tmp: string, final: string): void {
  const old = `${final}.old-${process.pid}`;
  const had = fs.existsSync(final);
  if (had) {
    fs.renameSync(final, old);
  }
  try {
    fs.renameSync(tmp, final);
  } catch (error) {
    if (had) {
      fs.renameSync(old, final);
    }
    throw error;
  }
  if (had) {
    fs.rmSync(old, { force: true, recursive: true });
  }
}

export async function generateSemantics(
  options: SemanticsGenerateOptions
): Promise<SemanticsGenerationResult> {
  const root = fs.realpathSync(path.resolve(options.root));
  const config = options.config ?? loadSemanticsConfig(root);
  const now = options.now ?? startOfUtcDay(new Date());
  const mode = options.mode ?? "full";
  const dryRun = options.dryRun === true;
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const analyzeLocal = options.analyzeLocal ?? spawnLocalAnalyzer;
  const derive = options.derive ?? spawnDeriver;
  const progress = options.onProgress ?? (() => undefined);
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

  const output = path.resolve(root, config.output);
  const cacheDir = path.resolve(root, options.cache ?? DEFAULT_SEMANTICS_CACHE);
  const release = dryRun ? () => undefined : acquireCacheLock(cacheDir);
  const tmp = `${output}.tmp-${process.pid}`;
  const previous = fs.existsSync(output) ? output : undefined;
  if (!dryRun) {
    fs.rmSync(tmp, { force: true, recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
  }
  const writer = new Writer(tmp, previous);

  try {
    const discovery: SemanticsDiscovery = await timed(
      "discover",
      undefined,
      () => discoverSemanticsUnits(root, config)
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
    for (const id of new Set([
      ...listCachedPackages(cacheDir, "package-local"),
      ...listCachedPackages(cacheDir, "package-report"),
    ])) {
      if (discovered.has(id)) {
        continue;
      }
      invalidations.push({
        id,
        kind: "package-report",
        reason: { cause: "package-removed", type: "direct" },
        status: "remove",
      });
      if (!dryRun) {
        removePackage(cacheDir, id);
      }
    }
    const recomputeLocal = plans.filter(
      (p) => p.local.invalidation.status === "recompute"
    );
    const recomputeReports = plans.filter(
      (p) => p.report.invalidation.status === "recompute"
    );
    // Derivation reads every package, so one invalidated report derives all.
    const deriving = recomputeReports.length > 0;
    for (const stage of WORKSPACE_STAGES) {
      invalidations.push({
        id: stage,
        kind: "workspace-stage",
        reason: {
          source: (stage === "workspaceDerivation"
            ? recomputeLocal
            : recomputeReports
          ).map((p) => p.unit.id),
          type: "dependency",
        },
        status:
          stage === "workspaceDerivation" && !deriving ? "reuse" : "recompute",
      });
    }
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
        manifest: path.join(output, FILES.manifest),
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
    await timed(
      "derive",
      deriving
        ? `${outcomes.filter((o) => o.local !== undefined).length} local reports`
        : "every assembled report reused",
      async () => {
        if (!deriving) {
          for (const outcome of outcomes) {
            const report = planById.get(outcome.unit.id)?.report.cached?.value;
            if (report === undefined || outcome.local === undefined) {
              continue;
            }
            outcome.report = report;
            outcome.reportSource = "reused";
            writer.write(reportFile(outcome.unit.id), report);
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
            canonicalSemanticsText(reportFile(unit.id), cachedReport) ===
              canonicalSemanticsText(reportFile(unit.id), fresh)
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
          writer.write(reportFile(unit.id), report);
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

    const reports = outcomes.flatMap((o) =>
      o.report === undefined ? [] : [o.report]
    );
    const workspaceName = rootName(root);
    const ingested = await timed("ingest", undefined, () =>
      ingestWorkspaceReports(reports, {
        root: workspaceName ?? path.basename(root),
      })
    );
    const workspace = await timed("intelligence", undefined, () =>
      analyzeWorkspace(ingested)
    );
    const context: WorkspaceProjectionContext =
      createWorkspaceProjectionContext(workspace);

    const modules = buildModuleRecords(workspace, reports);
    const concepts = buildConceptIndex(workspace);
    const edgeShards = buildModuleEdgeShards(workspace, reports);
    const couplings = buildCouplingIndex(workspace);

    await timed("project", undefined, () => {
      writer.write(
        FILES.projections.manifest,
        workspaceProjectionManifest(context)
      );
      writer.write(
        FILES.projections.overview,
        projectWorkspaceOverview(context)
      );
      writer.write(
        FILES.projections.packageRoles,
        projectWorkspaceMatrix(context, { kind: "package-concept-roles" })
      );
      writer.write(
        FILES.projections.directions,
        listConceptDirections(context)
      );
      writer.write(
        FILES.projections.boundaries,
        projectWorkspaceMatrix(context, {
          kind: "boundary-concept-load",
          metric: "concepts",
        })
      );
      writer.write(
        FILES.projections.dependencyGraph,
        projectWorkspaceGraph(context, "dependency-topology")
      );
      writer.write(
        FILES.projections.implementationFlow,
        projectWorkspaceGraph(context, "implementation-flow")
      );
      writer.write(
        FILES.projections.behaviorFlow,
        projectWorkspaceGraph(context, "behavior-flow")
      );
      writer.write(FILES.projections.patterns, listWorkspacePatterns(context));
      for (const { unit } of outcomes) {
        const projection = projectWorkspacePackage(context, unit.id);
        if (projection !== undefined) {
          writer.write(projectionFile(unit.id), projection);
        }
      }
    });

    const byPackage = new Map<string, SemanticsModuleRecord[]>();
    for (const module of modules) {
      (
        byPackage.get(module.package) ??
        byPackage.set(module.package, []).get(module.package)
      )?.push(module);
    }
    const shardPackages = [...byPackage.keys()].sort();

    await timed("write", undefined, () => {
      writer.write(FILES.workspace, workspace);
      writer.write(FILES.conceptIndex, concepts);
      writer.write(FILES.couplings, couplings);
      for (const shard of edgeShards) {
        writer.write(edgeShardFile(shard.package), shard);
      }
      const entries: SemanticsModuleIndexEntry[] = [];
      for (const id of shardPackages) {
        const shard: SemanticsModuleShard = {
          modules: byPackage.get(id) ?? [],
          package: id,
        };
        writer.write(shardFile(id), shard);
        for (const module of shard.modules) {
          entries.push({
            id: module.id,
            package: id,
            path: module.path,
            shard: shardFile(id),
            ...(module.role !== undefined && { role: module.role }),
            ...(module.fileKind !== undefined && { fileKind: module.fileKind }),
          });
        }
      }
      const moduleIndex: SemanticsModuleIndex = {
        coverage: {
          moduleEdges: "sharded",
          note: "Module record dependencies list cross-package module edges only. Every directed edge, intra-package and cross-package, is in the edge shard of the package owning its source module.",
        },
        edgeShards: edgeShards.map((shard) => ({
          crossPackage: shard.edges.filter((e) => e.scope === "cross-package")
            .length,
          file: edgeShardFile(shard.package),
          intraPackage: shard.edges.filter((e) => e.scope === "intra-package")
            .length,
          package: shard.package,
        })),
        modules: entries.sort((a, b) => a.id.localeCompare(b.id)),
        schemaVersion: SEMANTICS_DATASET_SCHEMA_VERSION,
        shards: shardPackages.map((id) => ({
          count: byPackage.get(id)?.length ?? 0,
          file: shardFile(id),
          package: id,
        })),
      };
      writer.write(FILES.moduleIndex, moduleIndex);
    });

    const workspacePackages = new Set(
      workspace.packages.packages.map((p) => p.id)
    );
    const packages: SemanticsManifestPackage[] = outcomes
      .map((outcome): SemanticsManifestPackage => {
        const { unit } = outcome;
        const count = byPackage.get(unit.id)?.length ?? 0;
        return {
          id: unit.id,
          name: unit.name,
          path: unit.path,
          root: unit.root,
          status: outcome.report === undefined ? "failed" : "complete",
          ...(outcome.report !== undefined && { report: reportFile(unit.id) }),
          ...(workspacePackages.has(unit.id) && {
            projection: projectionFile(unit.id),
          }),
          modules: {
            count,
            ...(count > 0 && { shard: shardFile(unit.id) }),
          },
          ...(outcome.error !== undefined && { error: outcome.error }),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    const failures = packages.filter((p) => p.status === "failed").length;
    const partial = failures > 0 || !workspace.ingestion.coverage.complete;
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
    const artifactsReused = writer.files.filter((f) => f.reused).length;
    const finishedAt = new Date();
    const manifest: SemanticsManifest = {
      counts: {
        boundaries: workspace.boundaries.boundaries.length,
        concepts: concepts.concepts.length,
        modules: modules.length,
        packages: workspace.packages.packages.length,
        patterns: context.index.patterns.length,
      },
      coverage: partial ? "partial" : "complete",
      discovery: {
        directoriesInspected: discovery.directoriesInspected,
        rootsMissing: discovery.rootsMissing,
        rootsScanned: discovery.rootsScanned,
        unitsAnalyzed: packages.length - failures,
        unitsDiscovered: discovery.units.length,
        unitsSkipped: discovery.skipped,
      },
      files: FILES,
      generatedAt: finishedAt.toISOString(),
      generation: {
        artifactsGenerated: writer.files.length - artifactsReused,
        artifactsReused,
        command: options.command ?? "generateSemantics",
        concurrency,
        derived: deriving,
        finishedAt: finishedAt.toISOString(),
        mode,
        packageFailures: failures,
        packagesAnalyzed: analyzed,
        packagesReused: reused,
        partial,
        phases,
        startedAt: startedAt.toISOString(),
        totalDurationMs: Math.round(performance.now() - started),
      },
      packages,
      roots: config.roots,
      schemaVersion: SEMANTICS_DATASET_SCHEMA_VERSION,
      versions: {
        packagePolicy: ANALYSIS_POLICY_VERSION,
        packageSchema: reports[0]?.schemaVersion ?? 35,
        projectionSchema: WORKSPACE_PROJECTION_SCHEMA_VERSION,
        workspaceIntelligencePolicy: WORKSPACE_INTELLIGENCE_POLICY_VERSION,
        workspaceSchema: WORKSPACE_SCHEMA_VERSION,
      },
      workspace: {
        ...(workspaceName !== undefined && { name: workspaceName }),
        root: path.basename(root),
      },
    };
    writer.write(FILES.manifest, manifest);

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
      manifest: path.join(output, FILES.manifest),
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
    fs.rmSync(tmp, { force: true, recursive: true });
    throw error;
  } finally {
    release();
  }
}
