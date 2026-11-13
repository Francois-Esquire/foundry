import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Project } from "ts-morph";
import {
  boundaryEntrypoints,
  findRepoRoot,
  ownerBoundary,
  resolveBoundary,
} from "./boundary";
import type { SourceOwner } from "./boundary-model";
import { EXCLUDED_DIRS, toPosix } from "./boundary-model";
import type { AnalysisConfig } from "./config";
import { cruiseWorkspace } from "./dependencies";
import { readFoldInputs } from "./fold-plan";
import type { GitHistory } from "./git-history";
import { collectGitHistory } from "./git-history";
import { createIgnorer } from "./ignore";
import { cruisedPaths } from "./module-graph";
import type { PackageLocalReport } from "./package-local-types";
import { createProject } from "./project";
import type { AnalysisProfile } from "./types";
import type { PreparedWorkspaceDerivation } from "./workspace-analysis";
import { analyzePreparedWorkspace, lap } from "./workspace-analysis";
import type { WorkspaceSurfaceDerivation } from "./workspace-derive-types";
import {
  emptyOwnerTable,
  foldDestinationCandidates,
  tableOwner,
  tableProgramOwners,
} from "./workspace-preparation";

// The workspace derivation's native side: acquiring its inputs (boundaries,
// the shared program, the dependency-cruiser pass, Git history, ownership
// and fold reads) and the wrapper that prepares and then analyzes. The
// computation over prepared inputs is `workspace-analysis.ts`.

export interface DeriveWorkspaceOptions {
  config?: AnalysisConfig;
  now?: Date;
  profile?: AnalysisProfile;
  /** A workspace program to reuse; created from `root` when absent. */
  project?: Project;
  root?: string;
  tsconfig?: string;
}

export async function deriveWorkspaceSurface(
  locals: PackageLocalReport[],
  options: DeriveWorkspaceOptions = {}
): Promise<WorkspaceSurfaceDerivation> {
  const started = performance.now();
  const prepared = await prepareWorkspaceDerivation(locals, options);
  const derivation = analyzePreparedWorkspace(locals, prepared, options.config);
  derivation.timing.totalMs = Math.round(performance.now() - started);
  return derivation;
}

/** False for a root-relative path inside an excluded directory. */
function isIncluded(file: string): boolean {
  return !file.split("/").some((segment) => EXCLUDED_DIRS.includes(segment));
}

/** Acquire a derivation's native inputs: boundaries, program, ownership, graph and history. */
export async function prepareWorkspaceDerivation(
  locals: readonly PackageLocalReport[],
  options: Omit<DeriveWorkspaceOptions, "config"> = {}
): Promise<PreparedWorkspaceDerivation> {
  const root = realpathSync(
    options.root ? resolve(options.root) : findRepoRoot(process.cwd())
  );
  const now = options.now ?? new Date();
  const profile = options.profile ?? "full";

  let done = lap();
  const project = options.project ?? createProject(root, options.tsconfig);
  const projectMs = done();

  const packages = locals.map((local) => {
    const boundary = resolveBoundary(root, local.package.path);
    return { boundary, entrypoints: boundaryEntrypoints(boundary) };
  });

  done = lap();
  const modules = await cruiseWorkspace(root, options.tsconfig);
  const cruiseMs = done();

  done = lap();
  const history: GitHistory =
    profile === "temporal"
      ? {
          analyzedAt: now.toISOString(),
          available: false,
          reason: "not-collected",
          root,
        }
      : await collectGitHistory(root, { now });
  const historyMs = done();

  // Owners are tabled only for the paths analysis can ask about, with each
  // lookup's error deferred until asked: the native lookup reads a manifest
  // only on the way up from a path it is given.
  const ownerOf: SourceOwner = (filePath) => ownerBoundary(root, filePath);
  const table = emptyOwnerTable();
  for (const file of project.getSourceFiles()) {
    tableOwner(table, file.getFilePath(), ownerOf);
  }
  tableProgramOwners(project, table, ownerOf);
  // Change coupling, radius and pressure own current tracked files outside
  // the graph; their commit filter drops excluded directories before asking.
  if (history.available) {
    for (const file of history.trackedFiles.filter(isIncluded)) {
      tableOwner(table, join(root, file), ownerOf);
    }
  }
  // The same in-root test `normalizeEdges` applies. A gitignored file can
  // still be in the program (imported, so loaded) and be a reference's
  // consumer, so it is owned too; callers skip node_modules themselves.
  const ignorer = createIgnorer(root);
  const ignored = new Map<string, boolean>();
  for (const absolute of cruisedPaths(root, modules)) {
    const rel = relative(root, absolute);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      continue;
    }
    const posix = toPosix(rel);
    const verdict = ignorer.ignores(posix);
    ignored.set(posix, verdict);
    if (!absolute.includes("/node_modules/")) {
      tableOwner(table, absolute, ownerOf);
    }
  }

  const fold = readFoldInputs(
    root,
    packages.map((entry) => entry.boundary),
    foldDestinationCandidates(table.owners)
  );

  return {
    fold,
    history,
    moduleGraph: { ignored, modules },
    now,
    ownerErrors: table.errors,
    owners: table.owners,
    packages,
    profile,
    project,
    root,
    timing: { cruiseMs, historyMs, projectMs },
  };
}
