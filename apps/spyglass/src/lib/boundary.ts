import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type {
  RepositoryReader,
  WorkspaceDeclaration,
} from "./boundary-manifest";
import {
  boundaryEntrypoints as boundaryEntrypointsWith,
  expandPattern as expandPatternWith,
  findRepoRoot as findRepoRootWith,
  manifestOwnerAt,
  ownerByManifests,
  packagePathAliases as packagePathAliasesWith,
  resolveBoundary as resolveBoundaryWith,
  workspaceDeclaration as workspaceDeclarationWith,
  workspaceMemberDirs,
  workspacePathAliases as workspacePathAliasesWith,
  workspacePatterns as workspacePatternsWith,
} from "./boundary-manifest";
import type {
  Boundary,
  BoundaryEntrypoint,
  DirectoryOwnership,
  DirectoryVerdict,
} from "./boundary-model";

// Boundaries and owners from the native file system. The manifest and
// workspace-pattern rules are `boundary-manifest.ts`, which this module
// answers with native reads; the boundary values and the lookups that read
// nothing are `boundary-model.ts`.

/** The manifest rules' questions, answered by the native file system. */
export const nativeRepositoryReader: RepositoryReader = {
  childDirectories: (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name)),
  exists: existsSync,
  isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
  readFile: (path) => readFileSync(path, "utf8"),
  realpath: realpathSync,
};

/** The entries directly below `dir` on the native file system; links are not directories. */
export function nativeDirectoryEntries(
  dir: string
): { directory: boolean; name: string }[] {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    directory: entry.isDirectory(),
    name: entry.name,
  }));
}

/** `workspaceDeclaration` over the native file system. */
export function workspaceDeclaration(
  root: string
): WorkspaceDeclaration | undefined {
  return workspaceDeclarationWith(nativeRepositoryReader, root);
}

/** The declaration's patterns, ready to expand; empty when the workspace declares none. */
export function workspacePatterns(root: string): readonly string[] {
  return workspacePatternsWith(nativeRepositoryReader, root);
}

/** Walk up from `start` to the nearest directory with a workspace declaration. */
export function findRepoRoot(start: string): string {
  return findRepoRootWith(nativeRepositoryReader, start);
}

export function expandPattern(root: string, pattern: string): string[] {
  return expandPatternWith(nativeRepositoryReader, root, pattern);
}

/** Every workspace package's declared entry points as source path aliases. */
export function workspacePathAliases(root: string): Record<string, string[]> {
  return workspacePathAliasesWith(nativeRepositoryReader, root);
}

/** The aliases one package's manifest declares for itself. */
export function packagePathAliases(dir: string): Record<string, string[]> {
  return packagePathAliasesWith(nativeRepositoryReader, dir);
}

/** The boundary package's declared, non-wildcard entrypoints as TypeScript sources. */
export function boundaryEntrypoints(boundary: Boundary): BoundaryEntrypoint[] {
  return boundaryEntrypointsWith(nativeRepositoryReader, boundary);
}

export function resolveBoundary(root: string, target: string): Boundary {
  return resolveBoundaryWith(nativeRepositoryReader, root, target);
}

const ownerCache = new Map<string, string>();
const workspaceDirsCache = new Map<string, Set<string> | null>();

/** Realpaths of the root's workspace package directories; null when the root declares none. */
function workspaceDirs(root: string): Set<string> | null {
  let dirs = workspaceDirsCache.get(root);
  if (dirs === undefined) {
    dirs = workspaceMemberDirs(nativeRepositoryReader, root);
    workspaceDirsCache.set(root, dirs);
  }
  return dirs;
}

/**
 * Name of the workspace boundary owning `filePath`: the nearest ancestor
 * workspace package's name (or its root-relative path when unnamed). A
 * manifest outside the root's workspace patterns (a skill nested in a
 * plugin, say) is not a boundary: its files belong to the enclosing
 * workspace package, the same package whose local analysis owns them. When
 * the root declares no workspaces, the nearest manifest owns the file.
 */
export function ownerBoundary(root: string, filePath: string): string {
  return ownerByManifests(
    nativeRepositoryReader,
    root,
    workspaceDirs(root),
    filePath,
    ownerCache
  );
}

const SNAPSHOT_SKIPPED_DIRS = new Set([".git", "node_modules"]);

/**
 * Read `ownerBoundary`'s per-directory verdicts for `root`: every directory
 * below it outside `node_modules` and `.git`, ignored trees included, so the
 * cost grows with the whole tree. Native workspace preparation does not
 * call it; it tables owners for the paths analysis asks about. This is the
 * native reference for the `DirectoryOwnership` contract that file-map
 * preparation answers from its map.
 */
export function snapshotDirectoryOwnership(root: string): DirectoryOwnership {
  const members = workspaceDirs(root);
  const verdicts = new Map<string, DirectoryVerdict>();
  const unwalked = new Set<string>();
  const record = (dir: string) => {
    try {
      const owner = manifestOwnerAt(nativeRepositoryReader, root, members, dir);
      if (owner !== undefined) {
        verdicts.set(dir, { owner });
      }
    } catch (error) {
      verdicts.set(dir, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unwalked.add(dir);
      continue;
    }
    // The native walk never reads the root's own manifest. Elsewhere it
    // reads one only where an entry could be it; the case-insensitive test
    // keeps case-insensitive file systems, and the read itself is native.
    if (
      dir !== root &&
      entries.some((entry) => entry.name.toLowerCase() === "package.json")
    ) {
      record(dir);
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink() || SNAPSHOT_SKIPPED_DIRS.has(entry.name)) {
        // Only directories matter, but a link's target is not read here.
        unwalked.add(child);
      } else if (entry.isDirectory()) {
        pending.push(child);
      }
    }
  }
  return { root, unwalked, verdicts };
}
