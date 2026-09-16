const DOT_PREFIX_PATTERN = /^\.\//;
const TRAILING_SLASHES_PATTERN = /\/+$/;

import { sep } from "node:path";

import ignore from "ignore";
import { sourceIssueFor, WorkspaceSourceUnavailableError } from "./errors";
import type { DirectoryEntry, WorkspaceFileSystem } from "./filesystem";
import { joinPath } from "./filesystem";
import { byCodeUnit } from "./ordering";

/**
 * The built-in exclusions, versioned so a later change to the set is an
 * observable input to reconciliation rather than a silent behavior drift.
 */
export const BASELINE_IGNORE_VERSION = 1;
export const BASELINE_IGNORE_PATTERNS: readonly string[] = [
  ".git/",
  ".foundry/",
  ".turbo/",
  "node_modules/",
  ".DS_Store",
  "Thumbs.db",
];

/**
 * The Workspace-relative POSIX form every File row and tree node uses.
 *
 * Unicode composition is normalized as well as separators. macOS hands back
 * decomposed names while a `.gitignore` rule, a stored row, and a renderer
 * selection are all composed, and comparing the two spellings byte-wise would
 * make one file look like two.
 */
export function normalizeRelativePath(hostRelativePath: string): string {
  const posix =
    sep === "/" ? hostRelativePath : hostRelativePath.split(sep).join("/");
  return posix
    .replace(DOT_PREFIX_PATTERN, "")
    .replace(TRAILING_SLASHES_PATTERN, "")
    .normalize("NFC");
}

/**
 * Git-compatible ignore evaluation over a stack of `.gitignore` files.
 *
 * Each entry in the stack is scoped to the directory that declared it, which is
 * what makes a nested `.gitignore` apply to its own subtree only.
 */
export interface IgnoreScope {
  /** POSIX path of the declaring directory, relative to the Workspace root. */
  readonly base: string;
  readonly matcher: ignore.Ignore;
}

export function baselineIgnoreScope(): IgnoreScope {
  return {
    base: "",
    matcher: ignore().add([...BASELINE_IGNORE_PATTERNS]),
  };
}

export function gitignoreScope(base: string, contents: string): IgnoreScope {
  return { base, matcher: ignore().add(contents) };
}

/**
 * Git's precedence rule: the deepest `.gitignore` that says anything definite
 * about a path decides it.
 *
 * The scope stack is ordered root-first, so walking it in order and keeping the
 * last definite verdict lets a nested `!pattern` re-include something a parent
 * excluded. Or-ing the scopes together would make every deeper negation
 * unreachable. `test()` is what distinguishes "this scope matched" from "this
 * scope was silent" — `ignores()` collapses both to false.
 *
 * Pruning an excluded directory before descending is not a gap in that rule:
 * Git cannot re-include a path inside an excluded directory either.
 */
export function isIgnored(
  scopes: readonly IgnoreScope[],
  relativePath: string,
  isDirectory: boolean
): boolean {
  let verdict = false;
  for (const scope of scopes) {
    const scoped = scopedPath(scope.base, relativePath);
    if (scoped === null) {
      continue;
    }
    const result = scope.matcher.test(isDirectory ? `${scoped}/` : scoped);
    if (result.ignored) {
      verdict = true;
    } else if (result.unignored) {
      verdict = false;
    }
  }
  return verdict;
}

/** The path as the declaring directory's own `.gitignore` sees it. */
function scopedPath(base: string, relativePath: string): string | null {
  if (base === "") {
    return relativePath;
  }
  const prefix = `${base}/`;
  return relativePath.startsWith(prefix)
    ? relativePath.slice(prefix.length)
    : null;
}

export interface WalkedFile {
  /**
   * Built from the raw entry names the source reported, never from
   * `relativePath` — a normalized spelling is not guaranteed to be openable on
   * a filesystem that stores names decomposed.
   */
  readonly absolutePath: string;
  readonly relativePath: string;
}

/**
 * Every included regular file beneath `root`, sorted by normalized relative
 * path.
 *
 * Symlinks — file or directory — are never followed, so a Workspace can neither
 * cycle nor silently catalog files outside its own root. Any traversal failure
 * aborts: a Workspace catalog must represent one complete observation, and a
 * skipped unreadable directory would quietly delete every File under it.
 *
 * The result is sorted rather than emitted in walk order, so the candidate
 * list, the diff, and both stores' `listFiles` all speak one ordering. This is
 * determinism for comparison, not a persisted directory model.
 */
export async function walkFiles(
  filesystem: WorkspaceFileSystem,
  root: string
): Promise<readonly WalkedFile[]> {
  const collected: WalkedFile[] = [];
  await walkDirectory(filesystem, root, "", [baselineIgnoreScope()], collected);
  // A total comparator, so equal paths are guaranteed adjacent — which is the
  // whole basis of the duplicate check on the next line.
  collected.sort(byCodeUnit((file: WalkedFile) => file.relativePath));
  assertDistinctPaths(collected);
  return collected;
}

/**
 * Two source names that normalize to one path would be one File row in SQLite
 * and two in memory. Refusing the whole observation keeps both stores honest
 * rather than letting the persistence choice decide what happened.
 *
 * This is only reachable on a filesystem that lets two names differing solely
 * by Unicode composition coexist in one directory. It is a real conflict in
 * the source, not a Workspace defect, and the only resolution is renaming one
 * of them — so the message names both spellings the source actually holds.
 */
function assertDistinctPaths(walked: readonly WalkedFile[]): void {
  for (const [index, file] of walked.entries()) {
    const previous = walked[index - 1];
    if (previous?.relativePath === file.relativePath) {
      throw new WorkspaceSourceUnavailableError(
        `Two source entries normalize to one Workspace path (${file.relativePath}). ` +
          `Rename one of them; their raw names are ${JSON.stringify(basenameOf(previous.absolutePath))} ` +
          `and ${JSON.stringify(basenameOf(file.absolutePath))}.`
      );
    }
  }
}

/** The final component only — the rest of an absolute path never travels. */
function basenameOf(absolutePath: string): string {
  return absolutePath.split(sep).at(-1) ?? absolutePath;
}

async function walkDirectory(
  filesystem: WorkspaceFileSystem,
  absoluteDirectory: string,
  relativeDirectory: string,
  inheritedScopes: readonly IgnoreScope[],
  collected: WalkedFile[]
): Promise<void> {
  let entries: readonly DirectoryEntry[];
  try {
    entries = await filesystem.readDirectory(absoluteDirectory);
  } catch (error) {
    throw new WorkspaceSourceUnavailableError(
      `Could not read directory ${relativeDirectory === "" ? "." : relativeDirectory}`,
      { cause: error, issue: sourceIssueFor(error) }
    );
  }

  const ordered = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
  const scopes = await extendScopes(
    filesystem,
    absoluteDirectory,
    relativeDirectory,
    ordered,
    inheritedScopes
  );

  for (const entry of ordered) {
    const relativePath = normalizeRelativePath(
      joinPath(relativeDirectory, entry.name)
    );
    const absolutePath = joinPath(absoluteDirectory, entry.name);
    if (entry.isSymbolicLink) {
      continue;
    }
    if (isIgnored(scopes, relativePath, entry.isDirectory)) {
      continue;
    }

    if (entry.isDirectory) {
      // biome-ignore lint/performance/noAwaitInLoops: Operations are intentionally sequential to preserve observation and mutation order.
      await walkDirectory(
        filesystem,
        absolutePath,
        relativePath,
        scopes,
        collected
      );
    } else if (entry.isFile) {
      collected.push({ absolutePath, relativePath });
    }
  }
}

async function extendScopes(
  filesystem: WorkspaceFileSystem,
  absoluteDirectory: string,
  relativeDirectory: string,
  entries: readonly DirectoryEntry[],
  inherited: readonly IgnoreScope[]
): Promise<readonly IgnoreScope[]> {
  const declaration = entries.find(
    (entry) => entry.name === ".gitignore" && entry.isFile
  );
  if (!declaration) {
    return inherited;
  }

  let contents: string;
  try {
    contents = new TextDecoder().decode(
      await filesystem.readFile(joinPath(absoluteDirectory, ".gitignore"))
    );
  } catch (error) {
    throw new WorkspaceSourceUnavailableError(
      `Could not read ${relativeDirectory === "" ? "" : `${relativeDirectory}/`}.gitignore`,
      { cause: error, issue: sourceIssueFor(error) }
    );
  }
  return [...inherited, gitignoreScope(relativeDirectory, contents)];
}
