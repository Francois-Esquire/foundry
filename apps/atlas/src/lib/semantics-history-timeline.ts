import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  SemanticsHistoryCommit,
  SemanticsHistoryConfig,
  TemporalModuleLineage,
  TemporalPathSegment,
} from "./semantics-history-types";

const statusPattern = /^\n/;
const hashPattern = /\n$/;
const isModulePathPattern = /\.tsx?$/;

// V12.3 timeline facts: first-parent commits with TypeScript file events,
// deterministic checkpoint selection, and module lineage replayed from the
// renames Git reports. Read-only Git, no checkout.

const run = promisify(execFile);
const MAX_BUFFER = 2 ** 28;

/** Rename detection threshold passed to `git log -M`; recorded in the manifest. */
export const RENAME_DETECTION = "-M50%";

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

function isModulePath(file: string): boolean {
  return isModulePathPattern.test(file) && !file.endsWith(".d.ts");
}

const RANGE = /^(\d+)([ymd])$/;

/** `1y` → the instant one year before `to`; `all` → undefined. */
export function rangeStart(range: string, to: Date): Date | undefined {
  if (range === "all") {
    return undefined;
  }
  const match = RANGE.exec(range);
  if (match === null) {
    throw new Error(
      `Unsupported history range "${range}"; use <n>y, <n>m, <n>d, or all`
    );
  }
  const amount = Number(match[1]);
  const start = new Date(to.getTime());
  if (match[2] === "y") {
    start.setUTCFullYear(start.getUTCFullYear() - amount);
  } else if (match[2] === "m") {
    start.setUTCMonth(start.getUTCMonth() - amount);
  } else {
    start.setUTCDate(start.getUTCDate() - amount);
  }
  return start;
}

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

/**
 * Parse `git log -z --numstat --format=%x01%H%x00%cI%x00%P`. Same token
 * layout as `parseGitLog` in git-history.ts, with parents in the third slot
 * and per-file records folded into add/remove/rename lists of module paths.
 * Newest first, as Git prints it.
 */
export function parseTimelineLog(output: string): SemanticsHistoryCommit[] {
  const commits: SemanticsHistoryCommit[] = [];
  for (const chunk of output.split("\x01").slice(1)) {
    const tokens = chunk.split("\0");
    const [hash, timestamp, parentList] = tokens;
    if (
      hash === undefined ||
      timestamp === undefined ||
      parentList === undefined
    ) {
      continue;
    }
    const parents = parentList
      .replace(hashPattern, "")
      .split(" ")
      .filter((p) => p !== "");
    const commit: SemanticsHistoryCommit = {
      additions: 0,
      changedFiles: 0,
      deletions: 0,
      hash,
      parents,
      timestamp,
    };
    const renamed: [string, string][] = [];
    let index = 3;
    index = parseTimelineLogEntries(index, tokens, commit, renamed);
    if (renamed.length > 0) {
      commit.renamed = renamed;
    }
    commits.push(commit);
  }
  return commits;
}

function parseTimelineLogEntries(
  initialIndex: number,
  tokens: string[],
  commit: SemanticsHistoryCommit,
  renamed: [string, string][]
): number {
  let index = initialIndex;
  while (index < tokens.length) {
    const token = tokens[index]?.replace(statusPattern, "") ?? "";
    index += 1;
    const match = NUMSTAT.exec(token);
    if (match === null) {
      continue;
    }
    const [, additions, deletions, inlinePath] = match;
    commit.changedFiles += 1;
    if (additions !== "-") {
      commit.additions += Number(additions);
    }
    if (deletions !== "-") {
      commit.deletions += Number(deletions);
    }
    if (inlinePath !== "") {
      continue;
    }
    const previous = tokens[index] ?? "";
    const next = tokens[index + 1] ?? "";
    index += 2;
    if (isModulePath(previous) || isModulePath(next)) {
      renamed.push([previous, next]);
    }
  }
  return index;
}

/**
 * Parse `git log -z --name-status --format=%x01%H` into per-commit
 * added/deleted module paths. Renames are taken from the numstat pass, so
 * `R` records are ignored here; `A` and `D` are the facts numstat lacks.
 */
export function parseStatusLog(
  output: string
): Map<string, { added: string[]; removed: string[] }> {
  const byHash = new Map<string, { added: string[]; removed: string[] }>();
  for (const chunk of output.split("\x01").slice(1)) {
    const tokens = chunk.split("\0");
    const hash = tokens[0]?.replace(hashPattern, "");
    if (hash === undefined || hash === "") {
      continue;
    }
    const entry = { added: [] as string[], removed: [] as string[] };
    let index = 1;
    index = parseStatusLogEntries(index, tokens, entry);
    byHash.set(hash, entry);
  }
  return byHash;
}

export interface TimelineOptions {
  /** Commit to end at; defaults to HEAD. */
  head?: string;
  /** Range expression from the history config. */
  range: string;
}

export interface Timeline {
  branch?: string;
  /** Oldest first. */
  commits: SemanticsHistoryCommit[];
  head: string;
  headTimestamp: string;
  /** Module paths present in the tree at the oldest commit's parent, when it has one. */
  seed: string[];
}

function parseStatusLogEntries(
  initialIndex: number,
  tokens: string[],
  entry: { added: string[]; removed: string[] }
): number {
  let index = initialIndex;
  while (index < tokens.length) {
    const status = tokens[index]?.replace(statusPattern, "") ?? "";
    index += 1;
    if (status === "") {
      continue;
    }
    const [code] = status;
    if (code === "R" || code === "C") {
      index += 2;
      continue;
    }
    const file = tokens[index] ?? "";
    index += 1;
    if (!isModulePath(file)) {
      continue;
    }
    if (code === "A") {
      entry.added.push(file);
    } else if (code === "D") {
      entry.removed.push(file);
    }
  }
  return index;
}

/**
 * First-parent history of `root` ending at HEAD, newest `range` worth of
 * commits. Two log passes: numstat for line counts and renames, name-status
 * for additions and deletions. Merge commits diff against their first
 * parent so nothing landing through a merge is invisible to lineage.
 */
export async function collectTimeline(
  root: string,
  options: TimelineOptions
): Promise<Timeline> {
  const head = (await git(root, ["rev-parse", options.head ?? "HEAD"])).trim();
  const headTimestamp = (
    await git(root, ["log", "-1", "--format=%cI", head])
  ).trim();
  const branch = (
    await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
      () => ""
    )
  ).trim();
  const since = rangeStart(options.range, new Date(headTimestamp));
  const common = [
    "--first-parent",
    "--diff-merges=first-parent",
    "-z",
    RENAME_DETECTION,
    ...(since === undefined ? [] : [`--since=${since.toISOString()}`]),
  ];
  const [numstat, status] = await Promise.all([
    git(root, [
      "log",
      ...common,
      "--numstat",
      "--format=%x01%H%x00%cI%x00%P",
      head,
      "--",
      ".",
    ]),
    git(root, [
      "log",
      ...common,
      "--name-status",
      "--format=%x01%H",
      head,
      "--",
      ".",
    ]),
  ]);
  const commits = parseTimelineLog(numstat).reverse();
  const statuses = parseStatusLog(status);
  for (const commit of commits) {
    const entry = statuses.get(commit.hash);
    const added = entry?.added ?? [];
    const removed = entry?.removed ?? [];
    if (added.length > 0) {
      commit.added = added;
    } else {
      commit.added = undefined;
    }
    if (removed.length > 0) {
      commit.removed = removed;
    }
  }
  const [oldest] = commits;
  const parent = oldest?.parents[0];
  const seed =
    parent === undefined
      ? []
      : (await git(root, ["ls-tree", "-r", "-z", "--name-only", parent]))
          .split("\0")
          .filter(isModulePath);
  return {
    head,
    headTimestamp,
    ...(branch !== "" && { branch }),
    commits,
    seed,
  };
}

// ---------------------------------------------------------------------------
// CHECKPOINTS

function monthKey(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

/**
 * Deterministic checkpoint selection over an oldest-first commit list.
 * Every strategy includes HEAD (the newest commit) and never repeats a
 * commit; the result is oldest first.
 *
 * - `monthly`: the last first-parent commit in each UTC calendar month,
 *   newest `checkpoints` months kept when there are more.
 * - `evenly-spaced`: `checkpoints` indices spread over the commit list,
 *   first and last included.
 * - `every-n-commits`: HEAD, then every `every`th commit walking back, up
 *   to `checkpoints` commits.
 */
export function selectCheckpoints(
  commits: SemanticsHistoryCommit[],
  policy: Pick<SemanticsHistoryConfig, "strategy" | "checkpoints" | "every">
): string[] {
  const count = Math.max(1, Math.floor(policy.checkpoints));
  const last = commits.length - 1;
  const head = commits[last];
  if (head === undefined) {
    return [];
  }
  const hashes = commits.map((commit) => commit.hash);
  let picked: string[];
  if (policy.strategy === "monthly") {
    const byMonth = new Map<string, string>();
    for (const commit of commits) {
      byMonth.set(monthKey(commit.timestamp), commit.hash);
    }
    picked = [...byMonth.values()];
    if (picked.at(-1) !== head.hash) {
      picked.push(head.hash);
    }
    picked = picked.slice(-count);
  } else if (policy.strategy === "evenly-spaced") {
    const n = Math.min(count, commits.length);
    picked = [];
    for (let i = 0; i < n; i += 1) {
      const index = n === 1 ? last : Math.round((i * last) / (n - 1));
      picked.push(hashes[index] ?? head.hash);
    }
  } else {
    const stride = Math.max(1, Math.floor(policy.every));
    picked = [];
    for (
      let index = last;
      index >= 0 && picked.length < count;
      index -= stride
    ) {
      picked.push(hashes[index] ?? head.hash);
    }
    picked.reverse();
  }
  return [...new Set(picked)];
}

// ---------------------------------------------------------------------------
// LINEAGE

interface LineageState {
  segments: TemporalPathSegment[];
}

export interface LineageIndex {
  /** checkpoint hash → path at that checkpoint → lineage id. */
  atCheckpoint: Map<string, Map<string, string>>;
  lineages: TemporalModuleLineage[];
}

/**
 * Replay the timeline oldest → newest. A rename carries the lineage to the
 * new path; an addition starts one; a deletion closes the open segment. A
 * path Git reports without a rename is delete + unrelated add, by
 * definition: no continuity is invented. The lineage id is its newest
 * path, so modules alive at HEAD keep their current dataset ids; two
 * lineages ending at the same path (delete, then recreate) are one
 * identity, as the same package path is the same module.
 */
export function buildLineage(
  commits: SemanticsHistoryCommit[],
  seed: string[],
  checkpoints: string[]
): LineageIndex {
  const live = new Map<string, LineageState>();
  const all: LineageState[] = [];
  const open = (path: string, since?: string): LineageState => {
    const state: LineageState = {
      segments: [{ path, ...(since !== undefined && { since }) }],
    };
    all.push(state);
    live.set(path, state);
    return state;
  };
  const close = (path: string, until: string): LineageState | undefined => {
    const state = live.get(path);
    if (state === undefined) {
      return undefined;
    }
    const segment = state.segments.at(-1);
    if (segment !== undefined) {
      segment.until = until;
    }
    live.delete(path);
    return state;
  };
  for (const path of [...seed].sort()) {
    open(path);
  }
  const wanted = new Set(checkpoints);
  const snapshots = new Map<string, Map<string, LineageState>>();
  buildLineageCommit(commits, close, open, live, wanted, snapshots);
  // Merge lineages sharing a final path, oldest segments first.
  const byId = new Map<string, TemporalModuleLineage>();
  const idOf = new Map<LineageState, string>();
  for (const state of all) {
    const id = state.segments.at(-1)?.path ?? "";
    idOf.set(state, id);
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, { id, segments: [...state.segments] });
    } else {
      existing.segments.push(...state.segments);
    }
  }
  const atCheckpoint = new Map<string, Map<string, string>>();
  for (const [hash, snapshot] of snapshots) {
    const paths = new Map<string, string>();
    for (const [path, state] of snapshot) {
      paths.set(path, idOf.get(state) ?? path);
    }
    atCheckpoint.set(hash, paths);
  }
  return {
    atCheckpoint,
    lineages: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function buildLineageCommit(
  commits: SemanticsHistoryCommit[],
  close: (path: string, until: string) => LineageState | undefined,
  open: (path: string, since?: string) => LineageState,
  live: Map<string, LineageState>,
  wanted: Set<string>,
  snapshots: Map<string, Map<string, LineageState>>
) {
  for (const commit of commits) {
    buildLineageCommitEntries(commit, close, open, live);
    for (const path of commit.removed ?? []) {
      close(path, commit.hash);
    }
    for (const path of commit.added ?? []) {
      if (!live.has(path)) {
        open(path, commit.hash);
      }
    }
    if (wanted.has(commit.hash)) {
      snapshots.set(commit.hash, new Map(live));
    }
  }
}

function buildLineageCommitEntries(
  commit: SemanticsHistoryCommit,
  close: (path: string, until: string) => LineageState | undefined,
  open: (path: string, since?: string) => LineageState,
  live: Map<string, LineageState>
) {
  for (const [previous, next] of commit.renamed ?? []) {
    if (!isModulePath(next)) {
      close(previous, commit.hash);
      continue;
    }
    close(next, commit.hash);
    if (!isModulePath(previous)) {
      open(next, commit.hash);
      continue;
    }
    let state = close(previous, commit.hash);
    if (state === undefined) {
      state = open(previous);
      close(previous, commit.hash);
    }
    state.segments.push({ path: next, since: commit.hash });
    live.set(next, state);
  }
}
