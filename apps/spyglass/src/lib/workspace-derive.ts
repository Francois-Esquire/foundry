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
import { noFoldInputs } from "./fold-inputs";
import { readFoldInputs } from "./fold-plan";
import type { GitHistory } from "./git-history";
import { collectGitHistory } from "./git-history";
import { createIgnorer } from "./ignore";
import { cruisedPaths } from "./module-graph";
import type { PackageLocalReport } from "./package-local-types";
import { createProject } from "./project";
import type { AnalysisProfile } from "./types";
import type { PreparedWorkspaceInputs } from "./workspace-analysis";
import {
  analyzeWorkspaceToFolds,
  completeWorkspace,
  foldRequests,
  lap,
} from "./workspace-analysis";
import type { WorkspaceSurfaceDerivation } from "./workspace-derive-types";
import {
  emptyOwnerTable,
  tableOwner,
  tableProgramOwners,
} from "./workspace-preparation";

export interface DeriveWorkspaceOptions {
  config?: AnalysisConfig;
  now?: Date;
  profile?: AnalysisProfile;

  project?: Project;
  root?: string;
  tsconfig?: string;
}

export async function deriveWorkspaceSurface(
  locals: PackageLocalReport[],
  options: DeriveWorkspaceOptions = {}
): Promise<WorkspaceSurfaceDerivation> {
  const started = performance.now();
  const prepared = await prepareWorkspaceInputs(locals, options);

  const stage = analyzeWorkspaceToFolds(locals, prepared, options.config);
  const { destinations, sources } = foldRequests(stage);
  const derivation = completeWorkspace(
    stage,
    sources.length === 0
      ? noFoldInputs(prepared.root)
      : readFoldInputs(prepared.root, sources, destinations)
  );
  derivation.timing.totalMs = Math.round(performance.now() - started);
  return derivation;
}

function isIncluded(file: string): boolean {
  return !file.split("/").some((segment) => EXCLUDED_DIRS.includes(segment));
}

export async function prepareWorkspaceInputs(
  locals: readonly PackageLocalReport[],
  options: Omit<DeriveWorkspaceOptions, "config">
): Promise<PreparedWorkspaceInputs> {
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

  const ownerOf: SourceOwner = (filePath) => ownerBoundary(root, filePath);
  const table = emptyOwnerTable();
  for (const file of project.getSourceFiles()) {
    tableOwner(table, file.getFilePath(), ownerOf);
  }
  tableProgramOwners(project, table, ownerOf);

  if (history.available) {
    for (const file of history.trackedFiles.filter(isIncluded)) {
      tableOwner(table, join(root, file), ownerOf);
    }
  }

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

  return {
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
