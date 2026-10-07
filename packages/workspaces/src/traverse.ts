import type { DirectoryEntry, StorageReader } from "@foundry/core/storage";
import { byCodeUnit } from "@foundry/lib/ordering";
import {
  joinFilesystemPath,
  lastPathSegment,
  normalizeStoragePath,
} from "@foundry/lib/paths";
import ignore from "ignore";
import { BASELINE_IGNORE_PATTERNS } from "./constants";
import { sourceIssueFor, WorkspaceSourceUnavailableError } from "./errors";
import type { IgnoreScope, WalkedEntry } from "./types";

function baselineIgnoreScope(): IgnoreScope {
  return {
    base: "",
    matcher: ignore().add([...BASELINE_IGNORE_PATTERNS]),
  };
}

function gitignoreScope(base: string, contents: string): IgnoreScope {
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
function isIgnored(
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

/** Links are cataloged without traversal. An incomplete scan never reaches the catalog. */
export async function walkEntries(
  filesystem: Pick<StorageReader, "readDirectory" | "readFile" | "separator">,
  root: string
): Promise<readonly WalkedEntry[]> {
  const collected: WalkedEntry[] = [];
  await walkDirectory(filesystem, root, "", [baselineIgnoreScope()], collected);
  // A total comparator, so equal paths are guaranteed adjacent — which is the
  // whole basis of the duplicate check on the next line.
  collected.sort(byCodeUnit((file: WalkedEntry) => file.relativePath));
  assertDistinctPaths(collected, filesystem.separator);
  return collected;
}

/**
 * Two source names that normalize to one path cannot both be catalogued.
 * Refusing the whole observation keeps the catalog honest rather than letting
 * whichever name sorted last silently win. Only the final component of each
 * raw name is reported — the rest of an absolute path never travels.
 *
 * This is only reachable on a filesystem that lets two names differing solely
 * by Unicode composition coexist in one directory. It is a real conflict in
 * the source, not a Workspace defect, and the only resolution is renaming one
 * of them — so the message names both spellings the source actually holds.
 */
function assertDistinctPaths(
  walked: readonly WalkedEntry[],
  separator: string
): void {
  for (const [index, file] of walked.entries()) {
    const previous = walked[index - 1];
    if (previous?.relativePath === file.relativePath) {
      throw new WorkspaceSourceUnavailableError(
        `Two source entries normalize to one Workspace path (${file.relativePath}). ` +
          `Rename one of them; their raw names are ${JSON.stringify(lastPathSegment(previous.absolutePath, separator))} ` +
          `and ${JSON.stringify(lastPathSegment(file.absolutePath, separator))}.`
      );
    }
  }
}

async function walkDirectory(
  filesystem: Pick<StorageReader, "readDirectory" | "readFile" | "separator">,
  absoluteDirectory: string,
  relativeDirectory: string,
  inheritedScopes: readonly IgnoreScope[],
  collected: WalkedEntry[]
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
    const relativePath = normalizeStoragePath(
      joinFilesystemPath(relativeDirectory, entry.name)
    );
    const absolutePath = joinFilesystemPath(
      absoluteDirectory,
      entry.name,
      filesystem.separator
    );
    if (entry.type === "unknown") {
      continue;
    }
    if (isIgnored(scopes, relativePath, entry.type === "directory")) {
      continue;
    }

    collected.push({ absolutePath, relativePath, type: entry.type });
    if (entry.type === "directory") {
      // Operations are intentionally sequential to preserve observation and mutation order.
      await walkDirectory(
        filesystem,
        absolutePath,
        relativePath,
        scopes,
        collected
      );
    }
  }
}

async function extendScopes(
  filesystem: Pick<StorageReader, "readFile" | "separator">,
  absoluteDirectory: string,
  relativeDirectory: string,
  entries: readonly DirectoryEntry[],
  inherited: readonly IgnoreScope[]
): Promise<readonly IgnoreScope[]> {
  const declaration = entries.find(
    (entry) => entry.name === ".gitignore" && entry.type === "file"
  );
  if (!declaration) {
    return inherited;
  }

  let contents: string;
  try {
    contents = new TextDecoder().decode(
      await filesystem.readFile(
        joinFilesystemPath(
          absoluteDirectory,
          ".gitignore",
          filesystem.separator
        )
      )
    );
  } catch (error) {
    throw new WorkspaceSourceUnavailableError(
      `Could not read ${relativeDirectory === "" ? "" : `${relativeDirectory}/`}.gitignore`,
      { cause: error, issue: sourceIssueFor(error) }
    );
  }
  return [...inherited, gitignoreScope(relativeDirectory, contents)];
}
