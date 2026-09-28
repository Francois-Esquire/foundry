import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ANALYSIS_POLICY_VERSION,
  WORKSPACE_INTELLIGENCE_POLICY_VERSION,
} from "./config";
import type { PackageLocalReport } from "./package-local-types";
import { PACKAGE_LOCAL_REPORT_SCHEMA_VERSION } from "./package-local-types";
import type { SemanticsDeriver, SemanticsLocalAnalyzer } from "./semantics";
import {
  mapBounded,
  moduleConceptRoles,
  replaceDirectory,
  rootName,
  spawnDeriver,
  spawnLocalAnalyzer,
} from "./semantics";
import {
  SEMANTICS_CACHE_SCHEMA_VERSION,
  writeJsonAtomic,
} from "./semantics-cache";
import {
  discoverSemanticsUnits,
  loadSemanticsConfig,
} from "./semantics-discover";
import { packageLocalFingerprint } from "./semantics-fingerprint";
import {
  buildLineage,
  collectTimeline,
  RENAME_DETECTION,
  selectCheckpoints,
} from "./semantics-history-timeline";
import type {
  SemanticsHistoryCheckpointTiming,
  SemanticsHistoryCommit,
  SemanticsHistoryConfig,
  SemanticsHistoryDeltaRef,
  SemanticsHistoryEntities,
  SemanticsHistoryGenerationResult,
  SemanticsHistoryManifest,
  SemanticsHistoryPhase,
  SemanticsHistoryPhaseTiming,
  SemanticsHistorySnapshotRef,
  SemanticsHistoryTimeline,
  TemporalCenterChange,
  TemporalConceptRole,
  TemporalConceptRoleChange,
  TemporalConceptState,
  TemporalModuleDependency,
  TemporalModuleState,
  TemporalPackageState,
  TemporalSnapshotDelta,
  TemporalWorkspaceSnapshot,
} from "./semantics-history-types";
import { SEMANTICS_HISTORY_SCHEMA_VERSION } from "./semantics-history-types";
import { stageFingerprint } from "./semantics-stages";
import type {
  SemanticsConfig,
  SemanticsDiscovery,
  SemanticsWorkspaceUnit,
} from "./semantics-types";
import type { SurfaceReport } from "./types";
import type { WorkspaceModuleGraphAnalysis } from "./workspace-graph-types";
import { ingestWorkspaceReports } from "./workspace-ingest";
import { analyzeWorkspace } from "./workspace-intelligence";
import type { WorkspaceReport } from "./workspace-types";
import {
  SUPPORTED_PACKAGE_SCHEMAS,
  WORKSPACE_SCHEMA_VERSION,
} from "./workspace-types";

// V12.3 temporal materializer. Each selected commit is checked out into a
// detached temporary worktree, analyzed by the current analyzer under the
// temporal profile, folded through the canonical workspace ingestion and
// intelligence, and projected to a compact snapshot. Snapshots are truth;
// lineage, deltas, and the manifest are derived from them and the timeline.

const execFileAsync = promisify(execFile);

const DEFAULT_HISTORY_OUTPUT = ".foundry/semantics-history";
const DEFAULT_HISTORY_CACHE = ".foundry/cache/semantics-history";

const FILES = {
  entities: "entities.json",
  manifest: "manifest.json",
  timeline: "timeline.json",
} as const;

function snapshotFile(commit: string): string {
  return `snapshots/${commit}.json`;
}

function deltaFile(from: string, to: string): string {
  return `deltas/${from}__${to}.json`;
}

type SemanticsHistoryProgressEvent =
  | { kind: "phase"; phase: SemanticsHistoryPhase; detail?: string }
  | {
      kind: "checkpoint";
      commit: string;
      timestamp: string;
      status: "complete" | "failed" | "cached";
      durationMs: number;
      done: number;
      total: number;
      error?: string;
    }
  | {
      kind: "unit";
      commit: string;
      unit: string;
      status: "complete" | "failed";
      durationMs: number;
    };

export interface SemanticsHistoryGenerateOptions {
  analyzeLocal?: SemanticsLocalAnalyzer;
  /** Repository-relative checkpoint cache directory. */
  cache?: string;
  command?: string;
  /** Package-local analyses in flight within one checkpoint. */
  concurrency?: number;
  config?: SemanticsConfig;
  derive?: SemanticsDeriver;
  /** Overrides for `config.history`, typically from CLI flags. */
  history?: Partial<SemanticsHistoryConfig>;
  onProgress?: (event: SemanticsHistoryProgressEvent) => void;
  /** Repository-relative output directory. */
  output?: string;
  root: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 ** 26,
  });
  return stdout;
}

// ---------------------------------------------------------------------------
// PROJECTION

interface UnitOutcome {
  error?: string;
  report?: SurfaceReport;
  unit: SemanticsWorkspaceUnit;
}

const ROLE_ORDER: TemporalConceptRole[] = [
  "declared",
  "behavior",
  "implementation",
  "representation",
  "usage",
  "conversion",
];

/** Path-keyed snapshot straight from the canonical workspace; lineage ids are applied later. */
function projectSnapshot(
  commit: SemanticsHistoryCommit,
  discovery: SemanticsDiscovery,
  outcomes: UnitOutcome[],
  workspace: WorkspaceReport,
  reports: SurfaceReport[]
): TemporalWorkspaceSnapshot {
  const analyzed = new Set(
    outcomes.filter((o) => o.report !== undefined).map((o) => o.unit.id)
  );
  const units = new Map(discovery.units.map((u) => [u.id, u]));
  const graph = workspace.intelligence?.graph;
  const packageFacts = new Map(
    (graph?.packages ?? []).map((p) => [p.package, p])
  );
  const moduleFacts = new Map((graph?.modules ?? []).map((m) => [m.module, m]));
  const roles = moduleConceptRoles(reports);

  const concepts: TemporalConceptState[] = (
    workspace.intelligence?.concepts?.concepts ?? []
  )
    .map((placement) => {
      const { centers } = placement;
      return {
        centers: {
          ...(centers?.semantic !== undefined && {
            semantic: centers.semantic,
          }),
          ...(centers?.behavior !== undefined && {
            behavior: centers.behavior,
          }),
          ...(centers?.representation !== undefined && {
            representation: centers.representation,
          }),
          ...(centers?.usage !== undefined && { usage: centers.usage }),
          ...(centers !== undefined &&
            centers.implementations.length > 0 && {
              implementations: [...centers.implementations].sort(),
            }),
        },
        id: placement.concept.id,
        kind: placement.concept.kind,
        name: placement.concept.name,
        package: placement.concept.package,
        packages: [...placement.presence.packages].sort(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const conceptIndex = new Map(concepts.map((c, i) => [c.id, i]));

  const modules: TemporalModuleState[] = [];
  const moduleCounts = new Map<string, number>();
  projectSnapshotModule(
    workspace,
    analyzed,
    moduleCounts,
    moduleFacts,
    roles,
    conceptIndex,
    modules
  );
  modules.sort((a, b) => a.id.localeCompare(b.id));
  const moduleIndex = new Map(modules.map((m, i) => [m.id, i]));

  const packages: TemporalPackageState[] = [...analyzed].sort().map((id) => {
    const unit = units.get(id);
    const facts = packageFacts.get(id);
    return {
      id,
      moduleCount: moduleCounts.get(id) ?? 0,
      path: unit?.path ?? "",
      root: unit?.root ?? "",
      ...(facts !== undefined && {
        fanIn: facts.direct.fanIn,
        fanOut: facts.direct.fanOut,
        layer: facts.layer,
      }),
    };
  });

  const dependencies: TemporalModuleDependency[] = [];
  const pushEdge = (
    from: string,
    to: string,
    scope: 0 | 1,
    typeOnly: boolean | undefined
  ): void => {
    const a = moduleIndex.get(from);
    const b = moduleIndex.get(to);
    if (a === undefined || b === undefined) {
      return;
    }
    dependencies.push([a, b, scope, typeOnly === true ? 1 : 0]);
  };
  for (const report of reports) {
    for (const edge of report.dependencyGravity.internalEdges) {
      pushEdge(edge.fromFile, edge.toFile, 0, edge.typeOnly);
    }
  }
  for (const edge of workspace.graph.moduleEdges) {
    pushEdge(edge.from, edge.to, 1, edge.typeOnly);
  }
  dependencies.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const boundaries = workspace.boundaries.boundaries
    .map((b) => ({ from: b.from, moduleEdges: b.moduleEdges, to: b.to }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return {
    boundaries,
    commit: commit.hash,
    concepts,
    coverage: {
      failed: outcomes
        .filter((o) => o.error !== undefined)
        .map((o) => ({ error: o.error ?? "", id: o.unit.id })),
      rootsMissing: discovery.rootsMissing,
      rootsScanned: discovery.rootsScanned,
      unitsAnalyzed: analyzed.size,
      unitsDiscovered: discovery.units.length,
    },
    dependencies,
    modules,
    packages,
    profile: "temporal",
    schemaVersion: SEMANTICS_HISTORY_SCHEMA_VERSION,
    timestamp: commit.timestamp,
  };
}

function projectSnapshotModule(
  workspace: WorkspaceReport,
  analyzed: Set<string>,
  moduleCounts: Map<string, number>,
  moduleFacts: Map<string, WorkspaceModuleGraphAnalysis>,
  roles: Map<
    string,
    Record<
      | "declared"
      | "behavior"
      | "implementation"
      | "representation"
      | "usage"
      | "conversion",
      Set<string>
    >
  >,
  conceptIndex: Map<string, number>,
  modules: TemporalModuleState[]
) {
  for (const module of workspace.graph.modules) {
    const pkg = module.package;
    if (pkg === undefined || !analyzed.has(pkg)) {
      continue;
    }
    moduleCounts.set(pkg, (moduleCounts.get(pkg) ?? 0) + 1);
    const facts = moduleFacts.get(module.id);
    const conceptRoles = roles.get(module.id);
    const byRole: Partial<Record<TemporalConceptRole, number[]>> = {};
    let any = false;
    if (conceptRoles !== undefined) {
      for (const role of ROLE_ORDER) {
        const indices = [...conceptRoles[role]]
          .flatMap((id) => {
            const index = conceptIndex.get(id);
            return index === undefined ? [] : [index];
          })
          .sort((a, b) => a - b);
        if (indices.length === 0) {
          continue;
        }
        byRole[role] = indices;
        any = true;
      }
    }
    modules.push({
      id: module.id,
      package: pkg,
      path: module.id,
      ...(module.fileKind !== undefined && { fileKind: module.fileKind }),
      ...(module.role !== undefined && { role: module.role.kind }),
      ...(facts !== undefined && { layer: facts.layer }),
      ...(any && { concepts: byRole }),
    });
  }
}

function conceptLineageId(
  conceptId: string,
  lineageOf: (file: string) => string
): string {
  const hash = conceptId.lastIndexOf("#");
  if (hash < 0) {
    return conceptId;
  }
  return `${lineageOf(conceptId.slice(0, hash))}${conceptId.slice(hash)}`;
}

/** Sort `items` by id; returns the sorted list and old index → new index. */
function sortById<T extends { id: string }>(
  items: T[]
): { sorted: T[]; remap: number[] } {
  const order = items
    .map((item, index) => ({ index, item }))
    .sort((a, b) => a.item.id.localeCompare(b.item.id));
  const remap = new Array<number>(items.length);
  order.forEach(({ index }, position) => {
    remap[index] = position;
  });
  return { remap, sorted: order.map(({ item }) => item) };
}

/**
 * Replace every module path and path-based concept id with its lineage id,
 * then restore id order. Index references (dependencies, module concept
 * roles) follow the permutation, so the file stays self-consistent.
 */
function rekeySnapshot(
  snapshot: TemporalWorkspaceSnapshot,
  paths: Map<string, string> | undefined
): TemporalWorkspaceSnapshot {
  const lineageOf = (file: string): string => paths?.get(file) ?? file;
  const concepts = sortById(
    snapshot.concepts.map((state) => ({
      ...state,
      id: conceptLineageId(state.id, lineageOf),
    }))
  );
  const modules = sortById(
    snapshot.modules.map((module) => ({
      ...module,
      id: lineageOf(module.path),
      ...(module.concepts !== undefined && {
        concepts: Object.fromEntries(
          Object.entries(module.concepts).map(([role, indices]) => [
            role,
            indices
              .map((index) => concepts.remap[index] ?? index)
              .sort((a, b) => a - b),
          ])
        ),
      }),
    }))
  );
  return {
    ...snapshot,
    concepts: concepts.sorted,
    dependencies: snapshot.dependencies
      .map(
        (edge): TemporalModuleDependency => [
          modules.remap[edge[0]] ?? edge[0],
          modules.remap[edge[1]] ?? edge[1],
          edge[2],
          edge[3],
        ]
      )
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    modules: modules.sorted,
  };
}

// ---------------------------------------------------------------------------
// DELTAS

function setDiff<T>(
  before: Iterable<T>,
  after: Iterable<T>
): { added: T[]; removed: T[] } {
  const a = new Set(before);
  const b = new Set(after);
  return {
    added: [...b].filter((x) => !a.has(x)),
    removed: [...a].filter((x) => !b.has(x)),
  };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function rolesOf(
  module: TemporalModuleState,
  concepts: TemporalConceptState[]
): Map<string, TemporalConceptRole[]> {
  const byConcept = new Map<string, TemporalConceptRole[]>();
  for (const role of ROLE_ORDER) {
    for (const index of module.concepts?.[role] ?? []) {
      const id = concepts[index]?.id;
      if (id === undefined) {
        continue;
      }
      (byConcept.get(id) ?? byConcept.set(id, []).get(id))?.push(role);
    }
  }
  return byConcept;
}

/** Dependency edges as `[sourceId, targetId]` pairs keyed for set comparison. */
function edgePairs(
  snapshot: TemporalWorkspaceSnapshot
): Map<string, [string, string]> {
  const pairs = new Map<string, [string, string]>();
  for (const [a, b] of snapshot.dependencies) {
    const source = snapshot.modules[a]?.id;
    const target = snapshot.modules[b]?.id;
    if (source === undefined || target === undefined) {
      continue;
    }
    pairs.set(`${source}→${target}`, [source, target]);
  }
  return pairs;
}

function diffSnapshots(
  from: TemporalWorkspaceSnapshot,
  to: TemporalWorkspaceSnapshot
): TemporalSnapshotDelta {
  const packagesBefore = new Map(from.packages.map((p) => [p.id, p]));
  const packagesAfter = new Map(to.packages.map((p) => [p.id, p]));
  const packageIds = setDiff(packagesBefore.keys(), packagesAfter.keys());
  const moduleCount: TemporalSnapshotDelta["packages"]["moduleCount"] = [];
  for (const [id, after] of packagesAfter) {
    const before = packagesBefore.get(id);
    if (before !== undefined && before.moduleCount !== after.moduleCount) {
      moduleCount.push({ from: before.moduleCount, id, to: after.moduleCount });
    }
  }

  const modulesBefore = new Map(from.modules.map((m) => [m.id, m]));
  const modulesAfter = new Map(to.modules.map((m) => [m.id, m]));
  const moduleIds = setDiff(modulesBefore.keys(), modulesAfter.keys());
  const renamed: TemporalSnapshotDelta["modules"]["renamed"] = [];
  const moved: TemporalSnapshotDelta["modules"]["moved"] = [];
  const roles: TemporalConceptRoleChange[] = [];
  const visitEntries = () => {
    for (const [id, after] of modulesAfter) {
      const before = modulesBefore.get(id);
      if (before === undefined) {
        continue;
      }
      if (before.path !== after.path) {
        renamed.push({ from: before.path, id, to: after.path });
      }
      if (before.package !== after.package) {
        moved.push({ from: before.package, id, to: after.package });
      }
      const rolesBefore = rolesOf(before, from.concepts);
      const rolesAfter = rolesOf(after, to.concepts);
      for (const concept of new Set([
        ...rolesBefore.keys(),
        ...rolesAfter.keys(),
      ])) {
        const a = rolesBefore.get(concept) ?? [];
        const b = rolesAfter.get(concept) ?? [];
        if (!sameList(a, b)) {
          roles.push({ concept, from: a, module: id, to: b });
        }
      }
    }
  };
  visitEntries();
  roles.sort(
    (a, b) =>
      a.module.localeCompare(b.module) || a.concept.localeCompare(b.concept)
  );

  const edgesBefore = edgePairs(from);
  const edgesAfter = edgePairs(to);
  const edgeIds = setDiff(edgesBefore.keys(), edgesAfter.keys());
  const pair = (key: string): [string, string] =>
    edgesBefore.get(key) ?? edgesAfter.get(key) ?? ["", ""];

  const conceptsBefore = new Map(from.concepts.map((c) => [c.id, c]));
  const conceptsAfter = new Map(to.concepts.map((c) => [c.id, c]));
  const conceptIds = setDiff(conceptsBefore.keys(), conceptsAfter.keys());
  const span: TemporalSnapshotDelta["concepts"]["span"] = [];
  const centers: TemporalCenterChange[] = [];
  for (const [id, after] of conceptsAfter) {
    const before = conceptsBefore.get(id);
    if (before === undefined) {
      continue;
    }
    if (!sameList(before.packages, after.packages)) {
      span.push({ from: before.packages, id, to: after.packages });
    }
    for (const center of [
      "semantic",
      "behavior",
      "representation",
      "usage",
    ] as const) {
      const a = before.centers[center];
      const b = after.centers[center];
      if (a !== b) {
        centers.push({
          center,
          id,
          ...(a !== undefined && { from: a }),
          ...(b !== undefined && { to: b }),
        });
      }
    }
  }

  const boundaryId = (b: { from: string; to: string }): string =>
    `${b.from}→${b.to}`;
  const boundariesBefore = new Map(
    from.boundaries.map((b) => [boundaryId(b), b])
  );
  const boundariesAfter = new Map(to.boundaries.map((b) => [boundaryId(b), b]));
  const boundaryIds = setDiff(boundariesBefore.keys(), boundariesAfter.keys());
  const moduleEdges: TemporalSnapshotDelta["boundaries"]["moduleEdges"] = [];
  for (const [id, after] of boundariesAfter) {
    const before = boundariesBefore.get(id);
    if (before !== undefined && before.moduleEdges !== after.moduleEdges) {
      moduleEdges.push({ from: before.moduleEdges, id, to: after.moduleEdges });
    }
  }

  return {
    boundaries: { ...boundaryIds, moduleEdges },
    concepts: {
      appeared: conceptIds.added,
      centers,
      disappeared: conceptIds.removed,
      span,
    },
    dependencies: {
      added: edgeIds.added.map(pair),
      removed: edgeIds.removed.map(pair),
    },
    from: from.commit,
    modules: { ...moduleIds, moved, renamed, roles },
    packages: { ...packageIds, moduleCount },
    schemaVersion: SEMANTICS_HISTORY_SCHEMA_VERSION,
    to: to.commit,
  };
}

// ---------------------------------------------------------------------------
// CHECKPOINT ANALYSIS

interface CheckpointContext {
  analyzeLocal: SemanticsLocalAnalyzer;
  concurrency: number;
  config: SemanticsConfig;
  derive: SemanticsDeriver;
  /** Content-addressed package-local reports shared by every checkpoint. */
  localCache: string;
  progress: (event: SemanticsHistoryProgressEvent) => void;
  root: string;
}

interface CheckpointResult {
  /** Package-local reports taken from the local cache rather than analyzed. */
  localsReused: number;
  snapshot: TemporalWorkspaceSnapshot;
  timing: Omit<SemanticsHistoryCheckpointTiming, "commit" | "cached">;
}

/**
 * A historical package's sources are immutable, so its local report is
 * keyed by content alone: the local fingerprint (sources, manifest, stage
 * version) names the file. Any checkpoint with the same package state
 * reuses it, and a derivation-policy change never reaches this cache.
 */
function readHistoricalLocal(file: string): PackageLocalReport | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const report = parsed as Partial<PackageLocalReport>;
    return report.schemaVersion === PACKAGE_LOCAL_REPORT_SCHEMA_VERSION &&
      typeof report.package === "object" &&
      Array.isArray(report.symbols)
      ? (parsed as PackageLocalReport)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detached worktree → discover → package-local analysis (cached by content)
 * → one workspace derivation (temporal profile) → ingest → intelligence →
 * project. The worktree is removed on every exit path; the repository's own
 * checkout, branch, and index are never touched.
 */
async function analyzeCheckpoint(
  context: CheckpointContext,
  commit: SemanticsHistoryCommit
): Promise<CheckpointResult> {
  const { root, config, concurrency, analyzeLocal, derive, progress } = context;
  const started = performance.now();
  const dir = mkdtempSync(join(tmpdir(), "semantics-history-"));
  const worktree = join(dir, "tree");
  const timing = {
    analyzeMs: 0,
    cleanupMs: 0,
    projectMs: 0,
    workspaceMs: 0,
    worktreeMs: 0,
  };
  let localsReused = 0;
  try {
    await git(root, [
      "worktree",
      "add",
      "--detach",
      "--quiet",
      worktree,
      commit.hash,
    ]);
    timing.worktreeMs = Math.round(performance.now() - started);
    const tree = realpathSync(worktree);
    const now = new Date(commit.timestamp);
    const discovery = discoverSemanticsUnits(tree, config);
    const at = performance.now();
    const localOutcomes = await mapBounded(
      discovery.units,
      concurrency,
      async (
        unit
      ): Promise<{
        unit: SemanticsWorkspaceUnit;
        local?: PackageLocalReport;
        error?: string;
      }> => {
        const unitStart = performance.now();
        try {
          const fingerprint = packageLocalFingerprint(tree, unit);
          const file = join(context.localCache, `${fingerprint.combined}.json`);
          let local = readHistoricalLocal(file);
          if (local === undefined) {
            local = await analyzeLocal(unit, { root: tree });
            writeJsonAtomic(file, local);
          } else {
            localsReused += 1;
          }
          progress({
            commit: commit.hash,
            durationMs: Math.round(performance.now() - unitStart),
            kind: "unit",
            status: "complete",
            unit: unit.id,
          });
          return { local, unit };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          progress({
            commit: commit.hash,
            durationMs: Math.round(performance.now() - unitStart),
            kind: "unit",
            status: "failed",
            unit: unit.id,
          });
          return { error: message, unit };
        }
      }
    );
    const locals = localOutcomes.flatMap((o) =>
      o.local === undefined ? [] : [o.local]
    );
    // A tree with units but no analyzable one carries no semantic state;
    // a tree with no units at all (roots absent yet) is a valid empty checkpoint.
    if (localOutcomes.length > 0 && locals.length === 0) {
      const first = localOutcomes.find((o) => o.error !== undefined);
      throw new Error(
        `every unit failed to analyze: ${first?.error ?? "unknown error"}`
      );
    }
    const derived =
      locals.length === 0
        ? { reports: [] }
        : await derive(locals, { now, profile: "temporal", root: tree });
    const reportByPath = new Map(
      derived.reports.map((report) => [report.target.path, report])
    );
    const outcomes: UnitOutcome[] = localOutcomes.map((outcome) => {
      const report = reportByPath.get(outcome.unit.path);
      return report === undefined
        ? { error: outcome.error ?? "no derived report", unit: outcome.unit }
        : { report, unit: outcome.unit };
    });
    timing.analyzeMs = Math.round(performance.now() - at);
    const reports = outcomes.flatMap((o) =>
      o.report === undefined ? [] : [o.report]
    );
    const workspaceAt = performance.now();
    const workspace = analyzeWorkspace(
      ingestWorkspaceReports(reports, {
        root: rootName(tree) ?? basename(root),
      })
    );
    timing.workspaceMs = Math.round(performance.now() - workspaceAt);
    const projectAt = performance.now();
    const snapshot = projectSnapshot(
      commit,
      discovery,
      outcomes,
      workspace,
      reports
    );
    timing.projectMs = Math.round(performance.now() - projectAt);
    return { localsReused, snapshot, timing };
  } finally {
    const cleanupAt = performance.now();
    await git(root, ["worktree", "remove", "--force", worktree]).catch(
      () => undefined
    );
    rmSync(dir, { force: true, recursive: true });
    await git(root, ["worktree", "prune"]).catch(() => undefined);
    timing.cleanupMs = Math.round(performance.now() - cleanupAt);
  }
}

// ---------------------------------------------------------------------------
// GENERATION

class Writer {
  readonly files: { file: string; bytes: number }[] = [];

  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  write(file: string, value: unknown): number {
    const target = join(this.dir, file);
    mkdirSync(dirname(target), { recursive: true });
    const text = JSON.stringify(value);
    writeFileSync(target, text);
    const bytes = Buffer.byteLength(text);
    this.files.push({ bytes, file });
    return bytes;
  }
}

/**
 * Identity of a cached checkpoint snapshot: the `historySnapshot` stage
 * closure (package analysis, workspace ingestion and intelligence, snapshot
 * schema) plus the discovery inputs. Projection and dataset schemas are not
 * in the closure, so their changes leave every snapshot reusable.
 */
export function historyFingerprint(config: SemanticsConfig): string {
  const material = JSON.stringify({
    exclude: [...config.exclude].sort(),
    profile: "temporal",
    roots: [...config.roots].sort(),
    stages: stageFingerprint("historySnapshot"),
  });
  return createHash("sha1").update(material).digest("hex").slice(0, 16);
}

/**
 * A cached snapshot is reused only when it parses, carries the current
 * snapshot schema, and names the commit it was cached under; anything else
 * is a miss and the checkpoint is analyzed again.
 */
function readCachedSnapshot(
  file: string,
  commit: string
): TemporalWorkspaceSnapshot | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const snapshot = parsed as Partial<TemporalWorkspaceSnapshot>;
    return snapshot.schemaVersion === SEMANTICS_HISTORY_SCHEMA_VERSION &&
      snapshot.commit === commit &&
      Array.isArray(snapshot.packages) &&
      Array.isArray(snapshot.modules)
      ? (parsed as TemporalWorkspaceSnapshot)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function generateSemanticsHistory(
  options: SemanticsHistoryGenerateOptions
): Promise<SemanticsHistoryGenerationResult> {
  const root = realpathSync(resolve(options.root));
  const config = options.config ?? loadSemanticsConfig(root);
  const policy: SemanticsHistoryConfig = {
    ...config.history,
    ...options.history,
  };
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const analyzeLocal = options.analyzeLocal ?? spawnLocalAnalyzer;
  const derive = options.derive ?? spawnDeriver;
  const progress = options.onProgress ?? (() => undefined);
  const output = resolve(root, options.output ?? DEFAULT_HISTORY_OUTPUT);
  const cacheDir = resolve(root, options.cache ?? DEFAULT_HISTORY_CACHE);
  // Keyed by content, so it sits outside the snapshot fingerprint directory
  // and outlives every derivation-policy change.
  const localCache = join(
    cacheDir,
    "local",
    `v${PACKAGE_LOCAL_REPORT_SCHEMA_VERSION}`
  );
  const fingerprint = historyFingerprint(config);
  const startedAt = new Date();
  const started = performance.now();
  const phases: SemanticsHistoryPhaseTiming[] = [];
  const timed = async <T>(
    name: SemanticsHistoryPhase,
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

  const tmp = `${output}.tmp-${process.pid}`;
  rmSync(tmp, { force: true, recursive: true });
  mkdirSync(tmp, { recursive: true });
  const writer = new Writer(tmp);

  try {
    const timeline = await timed("timeline", undefined, () =>
      collectTimeline(root, { range: policy.range })
    );
    const selected = await timed("select", undefined, () =>
      selectCheckpoints(timeline.commits, policy)
    );
    const byHash = new Map(timeline.commits.map((c) => [c.hash, c]));
    const checkpoints = selected.flatMap((hash) => {
      const commit = byHash.get(hash);
      return commit === undefined ? [] : [commit];
    });
    for (const commit of checkpoints) {
      commit.checkpoint = true;
    }

    const cacheRoot = join(
      cacheDir,
      `v${SEMANTICS_CACHE_SCHEMA_VERSION}`,
      fingerprint
    );
    const refs: SemanticsHistorySnapshotRef[] = [];
    const timings: SemanticsHistoryCheckpointTiming[] = [];
    const raw = new Map<string, TemporalWorkspaceSnapshot>();
    await timed("analyze", `${checkpoints.length} checkpoints`, async () => {
      let done = 0;
      for (const commit of checkpoints) {
        const at = performance.now();
        const cacheFile = join(cacheRoot, `${commit.hash}.json`);
        const emit = (
          status: "complete" | "failed" | "cached",
          error?: string
        ): void => {
          done += 1;
          progress({
            commit: commit.hash,
            done,
            durationMs: Math.round(performance.now() - at),
            kind: "checkpoint",
            status,
            timestamp: commit.timestamp,
            total: checkpoints.length,
            ...(error !== undefined && { error }),
          });
        };
        const cached = readCachedSnapshot(cacheFile, commit.hash);
        if (cached !== undefined) {
          raw.set(commit.hash, cached);
          timings.push({
            analyzeMs: 0,
            cached: true,
            cleanupMs: 0,
            commit: commit.hash,
            projectMs: 0,
            workspaceMs: 0,
            worktreeMs: 0,
          });
          refs.push({
            cached: true,
            commit: commit.hash,
            durationMs: Math.round(performance.now() - at),
            status: "complete",
            timestamp: commit.timestamp,
          });
          emit("cached");
          continue;
        }
        try {
          const result = await analyzeCheckpoint(
            {
              analyzeLocal,
              concurrency,
              config,
              derive,
              localCache,
              progress,
              root,
            },
            commit
          );
          writeJsonAtomic(cacheFile, result.snapshot);
          raw.set(commit.hash, result.snapshot);
          timings.push({
            cached: false,
            commit: commit.hash,
            ...result.timing,
            localsReused: result.localsReused,
          });
          refs.push({
            cached: false,
            commit: commit.hash,
            durationMs: Math.round(performance.now() - at),
            status: "complete",
            timestamp: commit.timestamp,
          });
          emit("complete");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          refs.push({
            cached: false,
            commit: commit.hash,
            durationMs: Math.round(performance.now() - at),
            error: message,
            status: "failed",
            timestamp: commit.timestamp,
          });
          emit("failed", message);
        }
      }
    });

    const lineage = await timed("lineage", undefined, () =>
      buildLineage(timeline.commits, timeline.seed, selected)
    );
    const snapshots = new Map<string, TemporalWorkspaceSnapshot>();
    for (const [hash, snapshot] of raw) {
      snapshots.set(
        hash,
        rekeySnapshot(snapshot, lineage.atCheckpoint.get(hash))
      );
    }

    const successful = checkpoints.filter((c) => snapshots.has(c.hash));
    const deltas = await timed("deltas", undefined, () => {
      const list: { from: string; to: string; delta: TemporalSnapshotDelta }[] =
        [];
      const ordered = successful.flatMap((commit) => {
        const snapshot = snapshots.get(commit.hash);
        return snapshot === undefined ? [] : [snapshot];
      });
      for (let i = 1; i < ordered.length; i += 1) {
        const from = ordered[i - 1];
        const to = ordered[i];
        if (from === undefined || to === undefined) {
          continue;
        }
        list.push({
          delta: diffSnapshots(from, to),
          from: from.commit,
          to: to.commit,
        });
      }
      return list;
    });

    const deltaRefs: SemanticsHistoryDeltaRef[] = [];
    await timed("write", undefined, () => {
      for (const ref of refs) {
        const snapshot = snapshots.get(ref.commit);
        if (snapshot === undefined) {
          continue;
        }
        const file = snapshotFile(ref.commit);
        ref.file = file;
        ref.bytes = writer.write(file, snapshot);
        ref.counts = {
          boundaries: snapshot.boundaries.length,
          concepts: snapshot.concepts.length,
          dependencies: snapshot.dependencies.length,
          modules: snapshot.modules.length,
          packages: snapshot.packages.length,
        };
      }
      for (const { from, to, delta } of deltas) {
        const file = deltaFile(from, to);
        deltaRefs.push({ bytes: writer.write(file, delta), file, from, to });
      }
      const packages = new Map<string, string[]>();
      for (const commit of successful) {
        for (const pkg of snapshots.get(commit.hash)?.packages ?? []) {
          (packages.get(pkg.id) ?? packages.set(pkg.id, []).get(pkg.id))?.push(
            commit.hash
          );
        }
      }
      const entities: SemanticsHistoryEntities = {
        modules: lineage.lineages,
        packages: [...packages.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, packageCheckpoints]) => ({
            checkpoints: packageCheckpoints,
            id,
          })),
        schemaVersion: SEMANTICS_HISTORY_SCHEMA_VERSION,
      };
      writer.write(FILES.entities, entities);
      const timelineFile: SemanticsHistoryTimeline = {
        commits: timeline.commits,
        schemaVersion: SEMANTICS_HISTORY_SCHEMA_VERSION,
      };
      writer.write(FILES.timeline, timelineFile);
    });

    const [oldest] = timeline.commits;
    const newest = timeline.commits.at(-1);
    const finishedAt = new Date();
    const manifest: SemanticsHistoryManifest = {
      deltas: deltaRefs,
      files: FILES,
      fingerprint,
      generatedAt: finishedAt.toISOString(),
      generation: {
        cachedSnapshots: refs.filter((r) => r.cached).length,
        checkpoints: timings,
        concurrency,
        durationMs: Math.round(performance.now() - started),
        failedSnapshots: checkpoints.length - successful.length,
        finishedAt: finishedAt.toISOString(),
        phases,
        requestedSnapshots: checkpoints.length,
        startedAt: startedAt.toISOString(),
        successfulSnapshots: successful.length,
        timelineCommits: timeline.commits.length,
      },
      policy: {
        checkpointCount: policy.checkpoints,
        checkpointStrategy: policy.strategy,
        every: policy.every,
        exclude: config.exclude,
        historyMode: "first-parent",
        profile: "temporal",
        renameDetection: RENAME_DETECTION,
        roots: config.roots,
      },
      range: {
        from: oldest?.hash ?? timeline.head,
        fromTimestamp: oldest?.timestamp ?? timeline.headTimestamp,
        requested: policy.range,
        to: newest?.hash ?? timeline.head,
        toTimestamp: newest?.timestamp ?? timeline.headTimestamp,
      },
      repository: {
        head: timeline.head,
        ...(timeline.branch !== undefined && { branch: timeline.branch }),
      },
      schemaVersion: SEMANTICS_HISTORY_SCHEMA_VERSION,
      snapshots: refs,
      versions: {
        historySchema: SEMANTICS_HISTORY_SCHEMA_VERSION,
        packagePolicy: ANALYSIS_POLICY_VERSION,
        packageSchema: Math.max(...SUPPORTED_PACKAGE_SCHEMAS),
        workspaceIntelligencePolicy: WORKSPACE_INTELLIGENCE_POLICY_VERSION,
        workspaceSchema: WORKSPACE_SCHEMA_VERSION,
      },
    };
    writer.write(FILES.manifest, manifest);
    replaceDirectory(tmp, output);
    return {
      bytes: writer.files.reduce((sum, f) => sum + f.bytes, 0),
      files: writer.files.length,
      manifest,
      output,
    };
  } catch (error) {
    rmSync(tmp, { force: true, recursive: true });
    throw error;
  }
}
