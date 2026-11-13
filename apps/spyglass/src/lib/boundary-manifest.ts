import { parse as parseYaml } from "yaml";
import { dirname, join, relative, resolve } from "#path";
import type { Boundary, BoundaryEntrypoint } from "./boundary-model";
import { ROOT_OWNER, toPosix } from "./boundary-model";
import type { SemanticsDeclarationSource } from "./semantics-types";

// Manifest and workspace-pattern rules over a repository reader: which
// directories are workspace packages, what a manifest declares as entry
// points and aliases, and which boundary a manifest directory names.
// `boundary.ts` answers the reader from the native file system;
// `file-map-preparation.ts` answers it from a recorded file map. Manifests and
// workspace files are parsed as data; nothing here executes repository code.

/**
 * The file-system questions the manifest rules ask, in the native spelling:
 * `exists` and `isDirectory` follow symbolic links, `childDirectories` lists
 * entries that are directories themselves (as `Dirent.isDirectory()`, so not
 * links to directories), and `readFile` throws for a missing file.
 */
export interface RepositoryReader {
  /** Absolute paths of the directories directly below `dir`. */
  childDirectories(dir: string): string[];
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readFile(path: string): string;
  realpath(path: string): string;
}

const isTsSourcePattern = /\.tsx?$/;

interface PackageJson {
  exports?: unknown;
  main?: string;
  module?: string;
  name?: string;
  private?: boolean;
  workspaces?: string[] | { packages?: string[] };
}

function readPackageJson(
  reader: RepositoryReader,
  dir: string
): PackageJson | undefined {
  const file = join(dir, "package.json");
  if (!reader.exists(file)) {
    return undefined;
  }
  return JSON.parse(reader.readFile(file)) as PackageJson;
}

/** The package patterns a workspace's package manager reads, and where they came from. */
export interface WorkspaceDeclaration {
  /** The patterns as the file lists them. */
  readonly declared: readonly string[];
  /**
   * The patterns the analyses expand, each through `normalizeWorkspacePath`:
   * negations dropped, and patterns that resolve to the workspace root or
   * escape it ignored.
   */
  readonly patterns: readonly string[];
  readonly source: SemanticsDeclarationSource;
}

const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";
const LEADING_DOT_SLASHES = /^(?:\.\/)+/;

/**
 * A workspace-relative POSIX path in its one spelling: a leading `./` and
 * trailing slashes removed. Undefined for a path that is empty, the root
 * itself (`.`), absolute, or not plain, with a backslash or an empty, `.`,
 * or `..` segment.
 */
export function normalizeWorkspacePath(path: string): string | undefined {
  const normalized = withoutTrailingSlashes(
    path.replace(LEADING_DOT_SLASHES, "")
  );
  const plain =
    normalized !== "" &&
    !normalized.startsWith("/") &&
    !normalized.includes("\\") &&
    normalized
      .split("/")
      .every(
        (segment) => segment !== "" && segment !== "." && segment !== ".."
      );
  return plain ? normalized : undefined;
}

/**
 * `path` without its trailing slashes, found by one backward scan: an
 * unanchored `/\/+$/` retries at every slash of a run that does not end the
 * string, which grows with the square of the run.
 */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") {
    end -= 1;
  }
  return path.slice(0, end);
}

function readOptional(
  reader: RepositoryReader,
  file: string
): string | undefined {
  return reader.exists(file) ? reader.readFile(file) : undefined;
}

/**
 * The workspace declaration: `pnpm-workspace.yaml#packages` when that file
 * lists packages, else `package.json#workspaces`, as an array or as
 * `{ "packages": [] }`. Undefined when neither declares a list. Read afresh
 * on every call. `**` is not expanded (see `expandPattern`).
 */
export function workspaceDeclaration(
  reader: RepositoryReader,
  root: string
): WorkspaceDeclaration | undefined {
  const pnpm = readOptional(reader, join(root, PNPM_WORKSPACE_FILE));
  const fromPnpm = pnpm === undefined ? undefined : pnpmPackages(pnpm);
  if (fromPnpm !== undefined) {
    return declarationOf(fromPnpm, "pnpm-workspace.yaml");
  }
  const workspaces = readPackageJson(reader, root)?.workspaces;
  const list = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  return Array.isArray(list)
    ? declarationOf(
        list.filter((pattern) => typeof pattern === "string"),
        "package.json#workspaces"
      )
    : undefined;
}

function pnpmPackages(text: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${PNPM_WORKSPACE_FILE}: the file is not valid YAML: ${reason.split("\n")[0]}`,
      { cause: error }
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("packages" in parsed)
  ) {
    return undefined;
  }
  const { packages } = parsed;
  if (
    !(
      Array.isArray(packages) &&
      packages.every((pattern) => typeof pattern === "string")
    )
  ) {
    throw new Error(
      `${PNPM_WORKSPACE_FILE}: packages must be a list of strings.`
    );
  }
  return packages;
}

function declarationOf(
  list: string[],
  source: SemanticsDeclarationSource
): WorkspaceDeclaration {
  return {
    declared: list,
    patterns: list.flatMap((pattern) => {
      const normalized = pattern.startsWith("!")
        ? undefined
        : normalizeWorkspacePath(pattern);
      return normalized === undefined ? [] : [normalized];
    }),
    source,
  };
}

/** The declaration's patterns, ready to expand; empty when the workspace declares none. */
export function workspacePatterns(
  reader: RepositoryReader,
  root: string
): readonly string[] {
  return workspaceDeclaration(reader, root)?.patterns ?? [];
}

/** Walk up from `start` to the nearest directory with a workspace declaration. */
export function findRepoRoot(reader: RepositoryReader, start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (workspaceDeclaration(reader, dir) !== undefined) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(start);
    }
    dir = parent;
  }
}

export function expandPattern(
  reader: RepositoryReader,
  root: string,
  pattern: string
): string[] {
  if (!pattern.includes("*")) {
    return [join(root, pattern)];
  }
  const [prefix] = pattern.split("*");
  const base = join(root, prefix ?? "");
  if (!reader.exists(base)) {
    return [];
  }
  return reader.childDirectories(base);
}

function readExportSubpaths(pkg: PackageJson): Set<string> | null {
  const { exports } = pkg;
  if (exports === undefined || exports === null) {
    return null;
  }
  if (typeof exports === "string") {
    return new Set([""]);
  }
  if (typeof exports !== "object") {
    return null;
  }
  const keys = Object.keys(exports);
  if (!keys.some((key) => key.startsWith("."))) {
    return new Set([""]);
  }
  const subpaths = new Set<string>();
  for (const key of keys) {
    if (key === ".") {
      subpaths.add("");
    } else if (key.startsWith("./")) {
      subpaths.add(key.slice(2));
    }
  }
  return subpaths;
}

function isTsSource(value: string): boolean {
  return isTsSourcePattern.test(value) && !value.endsWith(".d.ts");
}

function pickTsTarget(value: unknown): string | undefined {
  if (typeof value === "string") {
    return isTsSource(value) ? value : undefined;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const conditions = value as Record<string, unknown>;
  // A set, so `import` and `default` lead without being visited again in
  // their own place: each condition once, or nested conditions repeat.
  for (const key of new Set([
    "import",
    "default",
    ...Object.keys(conditions),
  ])) {
    if (!(key in conditions)) {
      continue;
    }
    const picked = pickTsTarget(conditions[key]);
    if (picked !== undefined) {
      return picked;
    }
  }
  return undefined;
}

/** Declared entry targets (subpath → package-relative TS source), first declaration wins. */
function packageEntryTargets(
  reader: RepositoryReader,
  pkg: PackageJson,
  dir: string
): Map<string, string> {
  const targets = new Map<string, string>();
  const add = (subpath: string, target: string) => {
    if (!targets.has(subpath)) {
      targets.set(subpath, target);
    }
  };
  const { exports } = pkg;
  if (typeof exports === "string" || (exports && typeof exports === "object")) {
    if (typeof exports === "string") {
      const target = pickTsTarget(exports);
      if (target !== undefined) {
        add("", target);
      }
    } else {
      const entries = Object.entries(exports as Record<string, unknown>);
      const hasSubpaths = entries.some(([key]) => key.startsWith("."));
      if (hasSubpaths) {
        packageEntryTargetsEntries(entries, add);
      } else {
        const target = pickTsTarget(exports);
        if (target !== undefined) {
          add("", target);
        }
      }
    }
  } else {
    const fallback = [pkg.module, pkg.main, "src/index.ts"].find(
      (candidate): candidate is string =>
        candidate !== undefined &&
        isTsSource(candidate) &&
        reader.exists(join(dir, candidate))
    );
    if (fallback !== undefined) {
      add("", fallback);
    }
  }
  return targets;
}

function packageEntryTargetsEntries(
  entries: [string, unknown][],
  add: (subpath: string, target: string) => void
) {
  for (const [key, value] of entries) {
    const target = pickTsTarget(value);
    if (target === undefined) {
      continue;
    }
    if (key === ".") {
      add("", target);
    } else if (key.startsWith("./")) {
      add(key.slice(2), target);
    }
  }
}

/**
 * Path aliases mapping each workspace package's declared entry points to its
 * TypeScript sources. TypeScript's own resolution follows the "types"
 * condition into built d.ts output, which would disconnect consumers from the
 * source declarations we analyze — these aliases force source resolution.
 */
export function workspacePathAliases(
  reader: RepositoryReader,
  root: string
): Record<string, string[]> {
  const aliases: Record<string, string[]> = {};
  for (const pattern of workspacePatterns(reader, root)) {
    for (const dir of expandPattern(reader, root, pattern)) {
      for (const [key, targets] of Object.entries(
        packagePathAliases(reader, dir)
      )) {
        aliases[key] ??= targets;
      }
    }
  }
  return aliases;
}

/** The aliases one package's manifest declares for itself. */
export function packagePathAliases(
  reader: RepositoryReader,
  dir: string
): Record<string, string[]> {
  const aliases: Record<string, string[]> = {};
  const pkg = readPackageJson(reader, dir);
  const name = pkg?.name;
  if (!pkg || name === undefined) {
    return aliases;
  }
  for (const [subpath, target] of packageEntryTargets(reader, pkg, dir)) {
    const key = subpath === "" ? name : `${name}/${subpath}`;
    aliases[key] ??= [join(dir, target)];
  }
  return aliases;
}

/**
 * The boundary package's declared entrypoints resolved to TypeScript sources.
 * Wildcard subpaths are not enumerable and are omitted — callers must check
 * `boundary.exportSubpaths` for wildcards separately.
 */
export function boundaryEntrypoints(
  reader: RepositoryReader,
  boundary: Boundary
): BoundaryEntrypoint[] {
  const pkg = readPackageJson(reader, boundary.dir);
  const name = boundary.packageName;
  if (!pkg || name === undefined) {
    return [];
  }
  const entries: BoundaryEntrypoint[] = [];
  for (const [subpath, target] of packageEntryTargets(
    reader,
    pkg,
    boundary.dir
  )) {
    if (subpath.includes("*") || target.includes("*")) {
      continue;
    }
    entries.push({
      entrypoint: subpath === "" ? name : `${name}/${subpath}`,
      file: toPosix(relative(boundary.root, join(boundary.dir, target))),
    });
  }
  return entries.sort((a, b) => a.entrypoint.localeCompare(b.entrypoint));
}

export function resolveBoundary(
  reader: RepositoryReader,
  root: string,
  target: string
): Boundary {
  let dir: string | undefined;
  const asPath = resolve(root, target);
  if (reader.isDirectory(asPath)) {
    dir = asPath;
  } else {
    for (const pattern of workspacePatterns(reader, root)) {
      for (const candidate of expandPattern(reader, root, pattern)) {
        if (readPackageJson(reader, candidate)?.name === target) {
          dir = candidate;
          break;
        }
      }
      if (dir) {
        break;
      }
    }
  }
  if (!dir) {
    throw new Error(
      `Cannot resolve target "${target}" as a directory under ${root} or a workspace package name.`
    );
  }
  dir = reader.realpath(dir);
  const relPath = toPosix(relative(root, dir));
  const pkg = readPackageJson(reader, dir);
  if (pkg) {
    return {
      dir,
      explicitlyPublishable: pkg.private === false,
      exportSubpaths: readExportSubpaths(pkg),
      packageName: pkg.name,
      relPath,
      root,
      type: "package",
    };
  }
  return {
    dir,
    explicitlyPublishable: false,
    exportSubpaths: null,
    relPath,
    root,
    type: "directory",
  };
}

/** Realpaths of the root's workspace package directories; null when the root declares none. */
export function workspaceMemberDirs(
  reader: RepositoryReader,
  root: string
): Set<string> | null {
  const patterns = workspacePatterns(reader, root);
  const dirs = patterns.length === 0 ? null : new Set<string>();
  for (const pattern of patterns) {
    for (const dir of expandPattern(reader, root, pattern)) {
      if (reader.exists(dir)) {
        dirs?.add(reader.realpath(dir));
      }
    }
  }
  return dirs;
}

/**
 * The boundary name a manifest directory gives the files below it, or
 * undefined when its manifest does not make it a boundary: no manifest, or,
 * when the root declares workspaces (`members` not null), a directory whose
 * realpath is not a workspace package directory. A manifest that does not
 * parse throws, as reading it does.
 */
export function manifestOwnerAt(
  reader: RepositoryReader,
  root: string,
  members: Set<string> | null,
  dir: string
): string | undefined {
  const pkg = readPackageJson(reader, dir);
  if (pkg && (members === null || members.has(reader.realpath(dir)))) {
    return pkg.name ?? toPosix(relative(root, dir));
  }
  return undefined;
}

/**
 * Name of the workspace boundary owning `filePath`: the nearest ancestor
 * workspace package's name (or its root-relative path when unnamed). A
 * manifest outside the root's workspace patterns (a skill nested in a
 * plugin, say) is not a boundary: its files belong to the enclosing
 * workspace package, the same package whose local analysis owns them. When
 * the root declares no workspaces (`members` null), the nearest manifest
 * owns the file. `cache` keeps each visited directory's answer.
 */
export function ownerByManifests(
  reader: RepositoryReader,
  root: string,
  members: Set<string> | null,
  filePath: string,
  cache: Map<string, string> = new Map()
): string {
  let dir = dirname(filePath);
  const visited: string[] = [];
  let owner: string | undefined;
  while (dir.startsWith(root) && dir !== root) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      owner = cached;
      break;
    }
    visited.push(dir);
    owner = manifestOwnerAt(reader, root, members, dir);
    if (owner !== undefined) {
      break;
    }
    dir = dirname(dir);
  }
  owner ??= ROOT_OWNER;
  for (const seen of visited) {
    cache.set(seen, owner);
  }
  return owner;
}
