import * as path from "node:path";
import { EXCLUDED_DIRS, ownerBoundary } from "./boundary";
import { classifyFile, renameAliases } from "./churn";
import type { AnalysisConfig } from "./config";
import type { CommitChange, GitHistory } from "./git-history";
import type {
  ChurnFileKind,
  CommitComposition,
  WorkspaceModuleGraph,
} from "./types";

// One historical commit-filter policy shared by change coupling, change
// radius, and evolutionary pressure: churn window, current eligible files,
// file-kind composition, and the oversized rule. Repository-root files
// (`<root>` owner) count as files but never as a package.

export const PAIR = "\0";
export const ROOT_OWNER = "<root>";
const DAY_MS = 86_400_000;

export type AvailableHistory = Extract<GitHistory, { available: true }>;

export interface CommitFilter {
  ownerOf: (file: string) => string;
  policy: AnalysisConfig["history"];
  windowDays: number | null;
}

export interface EligibleCommit {
  commit: CommitChange;
  composition: CommitComposition;
  /** Unique, sorted, current, non-excluded files of an eligible kind. */
  files: string[];
  filesByKind: Record<ChurnFileKind, number>;
  /** Fails the oversized rule; kept for metadata only. */
  oversized: boolean;
  /** Owning packages of `files`, sorted, without `<root>`. */
  packages: string[];
}

function isExcluded(file: string): boolean {
  return file.split("/").some((segment) => EXCLUDED_DIRS.includes(segment));
}

export function emptyKinds(): Record<ChurnFileKind, number> {
  return { config: 0, other: 0, source: 0, story: 0, test: 0 };
}

function compositionOf(
  filesByKind: Record<ChurnFileKind, number>,
  files: number,
  policy: AnalysisConfig["history"]["composition"]
): CommitComposition {
  const configShare = files === 0 ? 0 : filesByKind.config / files;
  if (configShare >= policy.configDominantMinShare) {
    return "config-dominant";
  }
  if (configShare <= policy.sourceDominantMaxConfigShare) {
    return "source-dominant";
  }
  return "mixed";
}

/**
 * Window commits with at least one eligible current file, newest first.
 * Historical paths resolve through the churn rename map; deleted paths and
 * excluded directories never appear. Oversized: more code files (source,
 * test, story) than the limit, or a config-dominant commit spanning enough
 * packages to read as a mechanical sweep.
 */
export function eligibleCommits(
  history: AvailableHistory,
  filter: CommitFilter
): EligibleCommit[] {
  const { policy } = filter;
  const now = Date.parse(history.analyzedAt);
  const since =
    filter.windowDays === null ? null : now - filter.windowDays * DAY_MS;
  const aliases = renameAliases(history.commits);
  const current = new Set(history.trackedFiles);
  const eligible = (file: string) =>
    current.has(file) &&
    !isExcluded(file) &&
    policy.eligibleKinds.includes(classifyFile(file));
  const result: EligibleCommit[] = [];
  for (const commit of history.commits) {
    if (since !== null && Date.parse(commit.timestamp) < since) {
      continue;
    }
    const files = [
      ...new Set(
        commit.files.map((change) => aliases.get(change.path) ?? change.path)
      ),
    ]
      .filter(eligible)
      .sort();
    if (files.length === 0) {
      continue;
    }
    const filesByKind = emptyKinds();
    for (const file of files) {
      filesByKind[classifyFile(file)] += 1;
    }
    const packages = [
      ...new Set(files.map(filter.ownerOf).filter((p) => p !== ROOT_OWNER)),
    ].sort();
    const composition = compositionOf(
      filesByKind,
      files.length,
      policy.composition
    );
    const codeFiles = files.length - filesByKind.config - filesByKind.other;
    result.push({
      commit,
      composition,
      files,
      filesByKind,
      oversized:
        codeFiles > policy.oversized.maxCodeFilesPerCommit ||
        (composition === "config-dominant" &&
          packages.length >= policy.oversized.configSweepMinPackages),
      packages,
    });
  }
  return result;
}

/** Owning package of any current file: graph ownership, else nearest package.json. */
export function ownerResolver(
  graph: WorkspaceModuleGraph,
  root: string
): (file: string) => string {
  return (file) =>
    graph.owners[file] ?? ownerBoundary(root, path.join(root, file));
}

/** Directed package edges (`from\0to`) implied by module edges across owners. */
export function packageEdgesOf(graph: WorkspaceModuleGraph): Set<string> {
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    const from = graph.owners[edge.fromFile];
    const to = graph.owners[edge.toFile];
    if (from !== undefined && to !== undefined && from !== to) {
      edges.add(`${from}${PAIR}${to}`);
    }
  }
  return edges;
}
