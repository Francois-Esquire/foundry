import type { Boundary } from "./boundary";
import { renameAliases } from "./churn";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type { CommitChange, GitHistory } from "./git-history";
import {
  eligibleCommits,
  ownerResolver,
  PAIR,
  packageEdgesOf,
} from "./history-commits";
import { distribution } from "./local-complexity";
import type {
  ChangeRadiusReport,
  CommitRadius,
  PackageCombination,
  WorkspaceModuleGraph,
} from "./types";

// Change radius: how much of the current architecture moves in one commit.
// Per target-touching commit: current eligible files, owning packages, and
// the static package edges with both ends touched. Raw counts and
// distributions only — no radius label, no score, no coupling strength.

export interface ChangeRadiusSource {
  boundary: Boundary;
  graph: WorkspaceModuleGraph;
}

function lineTotals(
  commit: CommitChange,
  files: Set<string>,
  aliasOf: (path: string) => string
): Pick<CommitRadius, "additions" | "deletions" | "linesChanged"> {
  let additions: number | null = null;
  let deletions: number | null = null;
  for (const change of commit.files) {
    if (!files.has(aliasOf(change.path))) {
      continue;
    }
    if (change.additions !== null) {
      additions = (additions ?? 0) + change.additions;
    }
    if (change.deletions !== null) {
      deletions = (deletions ?? 0) + change.deletions;
    }
  }
  return {
    additions,
    deletions,
    linesChanged:
      additions === null && deletions === null
        ? null
        : (additions ?? 0) + (deletions ?? 0),
  };
}

/**
 * Radius of every window commit touching the target, measured over the whole
 * repository: a db commit that also changes studio and artifacts has package
 * radius 3. Oversized commits (shared history policy) are listed in metadata
 * but kept out of distributions.
 */
export function analyzeChangeRadius(
  history: GitHistory,
  source: ChangeRadiusSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ChangeRadiusReport {
  if (!history.available) {
    return { available: false, reason: history.reason };
  }
  const { boundary, graph } = source;
  const policy = config.changeRadius;
  const { windowDays } = config.churn;
  const ownerOf = ownerResolver(graph, boundary.root);
  const packageEdges = packageEdgesOf(graph);
  const inTarget = (file: string) =>
    boundary.relPath === "" ||
    file === boundary.relPath ||
    file.startsWith(`${boundary.relPath}/`);
  const targetPackage = boundary.packageName ?? boundary.relPath;

  // Same rename map eligibleCommits uses, so line totals join the same files.
  const aliases = renameAliases(history.commits);
  const aliasOf = (file: string) => aliases.get(file) ?? file;

  let commitsObserved = 0;
  let commitsExcluded = 0;
  const commits: CommitRadius[] = [];
  const combinations = new Map<string, number>();
  for (const eligible of eligibleCommits(history, {
    ownerOf,
    policy: config.history,
    windowDays,
  })) {
    const { commit, files, packages: packageSet } = eligible;
    const targetFiles = files.filter(inTarget);
    if (targetFiles.length === 0) {
      continue;
    }
    commitsObserved += 1;
    if (eligible.oversized) {
      commitsExcluded += 1;
      continue;
    }
    const touched = new Set(packageSet);
    let boundaries = 0;
    for (const edge of packageEdges) {
      const [from, to] = edge.split(PAIR) as [string, string];
      if (touched.has(from) && touched.has(to)) {
        boundaries += 1;
      }
    }
    if (packageSet.length > 1) {
      const key = packageSet.join(PAIR);
      combinations.set(key, (combinations.get(key) ?? 0) + 1);
    }
    commits.push({
      composition: eligible.composition,
      files: files.length,
      filesByKind: eligible.filesByKind,
      hash: commit.hash,
      packageBoundariesCrossed: boundaries,
      packages: packageSet.length,
      sourceFiles: eligible.filesByKind.source,
      timestamp: commit.timestamp,
      ...lineTotals(commit, new Set(files), aliasOf),
      packageSet,
      targetFileShare: targetFiles.length / files.length,
      targetFiles: targetFiles.length,
      targetPackages: touched.has(targetPackage) ? 1 : 0,
    });
  }

  commits.sort(
    (a, b) =>
      b.packages - a.packages ||
      b.sourceFiles - a.sourceFiles ||
      b.files - a.files ||
      Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
      a.hash.localeCompare(b.hash)
  );
  const crossPackage = commits.filter((c) => c.packages > 1).length;
  const crossingBoundary = commits.filter(
    (c) => c.packageBoundariesCrossed > 0
  ).length;
  const total = commits.length;
  const rate = (n: number) => (total === 0 ? 0 : n / total);
  const packageCombinations: PackageCombination[] = [...combinations]
    .map(([key, count]) => ({ commits: count, packages: key.split(PAIR) }))
    .sort(
      (a, b) =>
        b.commits - a.commits ||
        a.packages.length - b.packages.length ||
        a.packages.join(",").localeCompare(b.packages.join(","))
    )
    .slice(0, policy.report.topCombinations);

  return {
    available: true,
    commits,
    history: {
      commitsEligible: total,
      commitsExcluded,
      commitsObserved,
      oversized: config.history.oversized,
      windowDays,
    },
    summary: {
      boundaries: distribution(commits.map((c) => c.packageBoundariesCrossed)),
      boundaryCrossingCommits: crossingBoundary,
      boundaryCrossingRate: rate(crossingBoundary),
      commits: total,
      crossPackageCommits: crossPackage,
      crossPackageRate: rate(crossPackage),
      files: distribution(commits.map((c) => c.files)),
      packageCombinations,
      packages: distribution(commits.map((c) => c.packages)),
      singlePackageCommits: total - crossPackage,
      sourceFiles: distribution(commits.map((c) => c.sourceFiles)),
    },
    target: targetPackage,
  };
}
