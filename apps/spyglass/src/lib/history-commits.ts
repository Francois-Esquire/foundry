import { join } from "#path";
import type { SourceOwner } from "./boundary-model";
import { EXCLUDED_DIRS } from "./boundary-model";
import { renameAliases } from "./churn";
import type { AnalysisConfig } from "./config";
import { classifyFile } from "./file-kind";
import type { CommitChange, GitHistory } from "./git-history";
import type {
  ChurnFileKind,
  CommitComposition,
  WorkspaceModuleGraph,
} from "./types";

export const PAIR = "\0";
const ROOT_OWNER = "<root>";
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

  files: string[];
  filesByKind: Record<ChurnFileKind, number>;

  oversized: boolean;

  packages: string[];
}

function isExcluded(file: string): boolean {
  return file.split("/").some((segment) => EXCLUDED_DIRS.includes(segment));
}

function emptyKinds(): Record<ChurnFileKind, number> {
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

export function ownerResolver(
  graph: WorkspaceModuleGraph,
  root: string,
  ownerOf: SourceOwner
): (file: string) => string {
  return (file) => graph.owners[file] ?? ownerOf(join(root, file));
}

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
