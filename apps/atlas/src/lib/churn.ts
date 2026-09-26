import type { Boundary } from "./boundary";
import { EXCLUDED_DIRS } from "./boundary";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import { classifyFile } from "./file-kind";
import type { CommitChange, GitHistory } from "./git-history";
import { distribution } from "./local-complexity";
import type {
  ChurnDistributions,
  ChurnFileKind,
  ChurnKindTotals,
  ChurnReport,
  ChurnSummary,
  FileChurn,
} from "./types";

// Churn: how each currently-tracked file has evolved through Git history.
// Inventory only — commit counts, line churn, recency, author spread — with
// no score, no threshold, and no combination with static structure.

const DAY_MS = 86_400_000;

interface PathStats {
  additions: number;
  authors: Map<string, number>;
  deletions: number;
  firstChangedAt?: string;
  lastChangedAt?: string;
  windowCommits: Set<string>;
}

function emptyStats(): PathStats {
  return {
    additions: 0,
    authors: new Map(),
    deletions: 0,
    windowCommits: new Set(),
  };
}

function isExcluded(file: string): boolean {
  return file.split("/").some((segment) => EXCLUDED_DIRS.includes(segment));
}

export { classifyFile };

/**
 * Attribute every commit to the path each changed file has today. Commits
 * walk newest → oldest, so when a rename is met the old name can be mapped
 * onto the already-resolved new name and every older change follows it.
 */
/**
 * Historical path → the path that content has today. Commits walk newest →
 * oldest, so when a rename is met the old name maps onto the already-
 * resolved new name; every older change then follows it. Shared by churn
 * and change coupling so both see one file identity.
 */
export function renameAliases(commits: CommitChange[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const commit of commits) {
    for (const change of commit.files) {
      if (change.previousPath !== undefined) {
        aliases.set(
          change.previousPath,
          aliases.get(change.path) ?? change.path
        );
      }
    }
  }
  return aliases;
}

function collectPathStats(
  history: Extract<GitHistory, { available: true }>,
  since: number | null
): Map<string, PathStats> {
  const stats = new Map<string, PathStats>();
  const aliases = renameAliases(history.commits);
  for (const commit of history.commits) {
    const inWindow = since === null || Date.parse(commit.timestamp) >= since;
    for (const change of commit.files) {
      const path = aliases.get(change.path) ?? change.path;
      let record = stats.get(path);
      if (record === undefined) {
        record = emptyStats();
        stats.set(path, record);
      }
      // Compare instants, not %cI strings: offsets vary across the log, and
      // log order is not strictly committer-date order on non-linear history.
      if (isLater(commit.timestamp, record.lastChangedAt)) {
        record.lastChangedAt = commit.timestamp;
      }
      if (
        record.firstChangedAt === undefined ||
        isLater(record.firstChangedAt, commit.timestamp)
      ) {
        record.firstChangedAt = commit.timestamp;
      }
      if (!inWindow) {
        continue;
      }
      record.windowCommits.add(commit.hash);
      record.additions += change.additions ?? 0;
      record.deletions += change.deletions ?? 0;
      record.authors.set(
        commit.author,
        (record.authors.get(commit.author) ?? 0) + 1
      );
    }
  }
  return stats;
}

/** True when `candidate` is a later instant than `current`, or current is unset. */
function isLater(candidate: string, current: string | undefined): boolean {
  return current === undefined || Date.parse(candidate) > Date.parse(current);
}

function daysBetween(from: string, to: number): number {
  return Math.floor((to - Date.parse(from)) / DAY_MS);
}

type UnrankedFileChurn = Omit<FileChurn, "rank">;

function fileChurn(
  file: string,
  stats: PathStats,
  now: number
): UnrankedFileChurn {
  const commits = stats.windowCommits.size;
  let primary: [string, number] | undefined;
  for (const entry of stats.authors) {
    if (primary === undefined || entry[1] > primary[1]) {
      primary = entry;
    }
  }
  return {
    additions: stats.additions,
    commits,
    deletions: stats.deletions,
    file,
    kind: classifyFile(file),
    linesChanged: stats.additions + stats.deletions,
    ...(stats.firstChangedAt !== undefined && {
      firstChangedAt: stats.firstChangedAt,
    }),
    ...(stats.lastChangedAt !== undefined && {
      daysSinceLastChange: daysBetween(stats.lastChangedAt, now),
      lastChangedAt: stats.lastChangedAt,
    }),
    authors: stats.authors.size,
    ...(primary !== undefined && {
      ownership: {
        primaryAuthor: primary[0],
        primaryAuthorShare: primary[1] / commits,
      },
    }),
  };
}

/**
 * Empirical percentile: the share of `sorted` strictly below `value`, so
 * the population maximum sits just under 1 and ties share one placement.
 */
export function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? 0) < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low / sorted.length;
}

function distributions(files: UnrankedFileChurn[]): ChurnDistributions {
  return {
    authorsPerFile: distribution(files.map((file) => file.authors)),
    commitsPerFile: distribution(files.map((file) => file.commits)),
    daysSinceLastChange: distribution(
      files.flatMap((file) =>
        file.daysSinceLastChange === undefined ? [] : [file.daysSinceLastChange]
      )
    ),
    linesChangedPerFile: distribution(files.map((file) => file.linesChanged)),
  };
}

function uniqueCommits(files: string[], stats: Map<string, PathStats>): number {
  const seen = new Set<string>();
  for (const file of files) {
    for (const hash of stats.get(file)?.windowCommits ?? []) {
      seen.add(hash);
    }
  }
  return seen.size;
}

function kindTotals(
  files: FileChurn[],
  kind: ChurnFileKind,
  stats: Map<string, PathStats>
): ChurnKindTotals {
  const ofKind = files.filter((file) => file.kind === kind);
  return {
    commits: uniqueCommits(
      ofKind.map((file) => file.file),
      stats
    ),
    files: ofKind.length,
    linesChanged: ofKind.reduce((sum, file) => sum + file.linesChanged, 0),
  };
}

function summarize(
  files: FileChurn[],
  stats: Map<string, PathStats>,
  deletedFiles: number
): ChurnSummary {
  const authors = new Set<string>();
  let lastChangedAt: string | undefined;
  for (const file of files) {
    for (const author of stats.get(file.file)?.authors.keys() ?? []) {
      authors.add(author);
    }
    if (
      file.lastChangedAt !== undefined &&
      isLater(file.lastChangedAt, lastChangedAt)
    ) {
      lastChangedAt = file.lastChangedAt;
    }
  }
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    additions,
    authors: authors.size,
    commits: uniqueCommits(
      files.map((file) => file.file),
      stats
    ),
    deletions,
    filesAnalyzed: files.length,
    linesChanged: additions + deletions,
    ...(lastChangedAt !== undefined && { lastChangedAt }),
    byKind: {
      config: kindTotals(files, "config", stats),
      other: kindTotals(files, "other", stats),
      source: kindTotals(files, "source", stats),
      story: kindTotals(files, "story", stats),
      test: kindTotals(files, "test", stats),
    },
    deletedFiles,
  };
}

/**
 * Churn for the boundary's current files from an already-collected history.
 * Pure: the only clock is `history.analyzedAt`. Window counts use committer
 * dates, the same clock Git's `--since` would; the window itself is applied
 * here so one collected history serves any window.
 */
export function analyzeChurn(
  history: GitHistory,
  boundary: Boundary,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ChurnReport {
  if (!history.available) {
    return { available: false, reason: history.reason };
  }
  const now = Date.parse(history.analyzedAt);
  const { windowDays } = config.churn;
  const since = windowDays === null ? null : now - windowDays * DAY_MS;
  const stats = collectPathStats(history, since);
  const inTarget = (file: string) =>
    boundary.relPath === "" ||
    file === boundary.relPath ||
    file.startsWith(`${boundary.relPath}/`);

  const tracked = history.trackedFiles.filter((file) => !isExcluded(file));
  const current = new Set(tracked);
  const toChurn = (file: string) =>
    fileChurn(file, stats.get(file) ?? emptyStats(), now);
  const repositoryFiles = tracked.map(toChurn);
  const rankBy = (metric: (file: UnrankedFileChurn) => number) => {
    const populations = new Map<ChurnFileKind, number[]>();
    for (const file of repositoryFiles) {
      let values = populations.get(file.kind);
      if (values === undefined) {
        values = [];
        populations.set(file.kind, values);
      }
      values.push(metric(file));
    }
    for (const values of populations.values()) {
      values.sort((a, b) => a - b);
    }
    return (file: UnrankedFileChurn) =>
      percentile(populations.get(file.kind) ?? [], metric(file));
  };
  const commitRank = rankBy((file) => file.commits);
  const lineChurnRank = rankBy((file) => file.linesChanged);
  const files = tracked
    .filter(inTarget)
    .sort()
    .map(toChurn)
    .map((file) => ({
      ...file,
      rank: {
        commitPercentile: commitRank(file),
        lineChurnPercentile: lineChurnRank(file),
      },
    }));
  let deletedFiles = 0;
  for (const path of stats.keys()) {
    if (inTarget(path) && !isExcluded(path) && !current.has(path)) {
      deletedFiles += 1;
    }
  }

  const windowCommits = history.commits.filter(
    (commit) =>
      commit.files.length > 0 &&
      (since === null || Date.parse(commit.timestamp) >= since)
  );
  const newest = windowCommits[0];
  const oldest = windowCommits[windowCommits.length - 1];
  const summary = summarize(files, stats, deletedFiles);
  return {
    available: true,
    distributions: distributions(files),
    files,
    history: {
      windowDays,
      ...(since !== null && { since: new Date(since).toISOString() }),
      analyzedAt: history.analyzedAt,
      commitsAnalyzed: windowCommits.length,
      ...(oldest !== undefined && { oldestCommit: oldest.hash }),
      ...(newest !== undefined && { newestCommit: newest.hash }),
      historyComplete: !history.shallow,
    },
    repository: {
      commits: uniqueCommits(tracked, stats),
      distributions: distributions(repositoryFiles),
      filesAnalyzed: repositoryFiles.length,
    },
    summary,
    target: {
      additions: summary.additions,
      authors: summary.authors,
      commits: summary.commits,
      deletions: summary.deletions,
      id: boundary.packageName ?? boundary.relPath,
      kind: "package",
      linesChanged: summary.linesChanged,
      ...(summary.lastChangedAt !== undefined && {
        daysSinceLastChange: daysBetween(summary.lastChangedAt, now),
        lastChangedAt: summary.lastChangedAt,
      }),
    },
  };
}
