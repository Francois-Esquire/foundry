import {
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
  ownerByManifests,
  packagePathAliases as packagePathAliasesWith,
  resolveBoundary as resolveBoundaryWith,
  workspaceDeclaration as workspaceDeclarationWith,
  workspaceMemberDirs,
  workspacePathAliases as workspacePathAliasesWith,
  workspacePatterns as workspacePatternsWith,
} from "./boundary-manifest";
import type { Boundary, BoundaryEntrypoint } from "./boundary-model";

export const nativeRepositoryReader: RepositoryReader = {
  childDirectories: (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : Number(a > b)))
      .map((name) => join(dir, name)),
  exists: existsSync,
  isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
  readFile: (path) => readFileSync(path, "utf8"),
  realpath: realpathSync,
};

export function nativeDirectoryEntries(
  dir: string
): { directory: boolean; name: string }[] {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    directory: entry.isDirectory(),
    name: entry.name,
  }));
}

export function workspaceDeclaration(
  root: string
): WorkspaceDeclaration | undefined {
  return workspaceDeclarationWith(nativeRepositoryReader, root);
}

export function workspacePatterns(root: string): readonly string[] {
  return workspacePatternsWith(nativeRepositoryReader, root);
}

export function findRepoRoot(start: string): string {
  return findRepoRootWith(nativeRepositoryReader, start);
}

export function expandPattern(root: string, pattern: string): string[] {
  return expandPatternWith(nativeRepositoryReader, root, pattern);
}

export function workspacePathAliases(root: string): Record<string, string[]> {
  return workspacePathAliasesWith(nativeRepositoryReader, root);
}

export function packagePathAliases(dir: string): Record<string, string[]> {
  return packagePathAliasesWith(nativeRepositoryReader, dir);
}

export function boundaryEntrypoints(boundary: Boundary): BoundaryEntrypoint[] {
  return boundaryEntrypointsWith(nativeRepositoryReader, boundary);
}

export function resolveBoundary(root: string, target: string): Boundary {
  return resolveBoundaryWith(nativeRepositoryReader, root, target);
}

const ownerCache = new Map<string, string>();
const workspaceDirsCache = new Map<string, Set<string> | null>();

function workspaceDirs(root: string): Set<string> | null {
  let dirs = workspaceDirsCache.get(root);
  if (dirs === undefined) {
    dirs = workspaceMemberDirs(nativeRepositoryReader, root);
    workspaceDirsCache.set(root, dirs);
  }
  return dirs;
}

export function ownerBoundary(root: string, filePath: string): string {
  return ownerByManifests(
    nativeRepositoryReader,
    root,
    workspaceDirs(root),
    filePath,
    ownerCache
  );
}
