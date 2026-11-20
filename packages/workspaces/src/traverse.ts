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

function scopedPath(base: string, relativePath: string): string | null {
  if (base === "") {
    return relativePath;
  }
  const prefix = `${base}/`;
  return relativePath.startsWith(prefix)
    ? relativePath.slice(prefix.length)
    : null;
}

export async function walkEntries(
  filesystem: Pick<StorageReader, "readDirectory" | "readFile" | "separator">,
  root: string
): Promise<readonly WalkedEntry[]> {
  const collected: WalkedEntry[] = [];
  await walkDirectory(filesystem, root, "", [baselineIgnoreScope()], collected);
  collected.sort(byCodeUnit((file: WalkedEntry) => file.relativePath));
  assertDistinctPaths(collected, filesystem.separator);
  return collected;
}

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
