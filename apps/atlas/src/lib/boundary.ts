import * as fs from "node:fs";
import * as path from "node:path";

/** Generated and vendored directories no analysis looks inside. */
export const EXCLUDED_DIRS = [
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "storybook-static",
];

/**
 * Test fixtures below an analyzed root are inputs to that package's tests,
 * not part of its semantic surface: their manifests would otherwise register
 * phantom workspace packages. Matched relative to the root, so analyzing a
 * fixture directory itself is unaffected.
 */
export const FIXTURE_DIR = "test/fixtures";

export interface Boundary {
  dir: string;
  /** True when package.json declares `"private": false`. */
  explicitlyPublishable: boolean;
  /**
   * Subpaths declared in package.json "exports" ("" = root entry).
   * null means no exports field: only the bare package name counts as public.
   */
  exportSubpaths: Set<string> | null;
  packageName?: string;
  relPath: string;
  root: string;
  type: "package" | "directory";
}

interface PackageJson {
  exports?: unknown;
  main?: string;
  module?: string;
  name?: string;
  private?: boolean;
  workspaces?: string[] | { packages?: string[] };
}

function readPackageJson(dir: string): PackageJson | undefined {
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson;
}

export function workspacePatterns(root: string): string[] {
  const pkg = readPackageJson(root);
  const workspaces = pkg?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces;
  }
  if (workspaces?.packages) {
    return workspaces.packages;
  }
  return [];
}

/** Walk up from `start` looking for a package.json with a workspaces field. */
export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    const pkg = readPackageJson(dir);
    if (pkg?.workspaces) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(start);
    }
    dir = parent;
  }
}

export function expandPattern(root: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    return [path.join(root, pattern)];
  }
  const [prefix] = pattern.split("*");
  const base = path.join(root, prefix ?? "");
  if (!fs.existsSync(base)) {
    return [];
  }
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(base, entry.name));
}

function readExportSubpaths(pkg: PackageJson): Set<string> | null {
  const exports = pkg.exports;
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
  return /\.tsx?$/.test(value) && !value.endsWith(".d.ts");
}

function pickTsTarget(value: unknown): string | undefined {
  if (typeof value === "string") {
    return isTsSource(value) ? value : undefined;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const conditions = value as Record<string, unknown>;
  for (const key of ["import", "default", ...Object.keys(conditions)]) {
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
  pkg: PackageJson,
  dir: string
): Map<string, string> {
  const targets = new Map<string, string>();
  const add = (subpath: string, target: string) => {
    if (!targets.has(subpath)) {
      targets.set(subpath, target);
    }
  };
  const exports = pkg.exports;
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
        fs.existsSync(path.join(dir, candidate))
    );
    if (fallback !== undefined) {
      add("", fallback);
    }
  }
  return targets;
}

/**
 * Path aliases mapping each workspace package's declared entry points to its
 * TypeScript sources. TypeScript's own resolution follows the "types"
 * condition into built d.ts output, which would disconnect consumers from the
 * source declarations we analyze — these aliases force source resolution.
 */
export function workspacePathAliases(root: string): Record<string, string[]> {
  const aliases: Record<string, string[]> = {};
  for (const pattern of workspacePatterns(root)) {
    for (const dir of expandPattern(root, pattern)) {
      for (const [key, targets] of Object.entries(packagePathAliases(dir))) {
        aliases[key] ??= targets;
      }
    }
  }
  return aliases;
}

/** The aliases one package's manifest declares for itself. */
export function packagePathAliases(dir: string): Record<string, string[]> {
  const aliases: Record<string, string[]> = {};
  const pkg = readPackageJson(dir);
  const name = pkg?.name;
  if (!pkg || name === undefined) {
    return aliases;
  }
  for (const [subpath, target] of packageEntryTargets(pkg, dir)) {
    const key = subpath === "" ? name : `${name}/${subpath}`;
    aliases[key] ??= [path.join(dir, target)];
  }
  return aliases;
}

export interface BoundaryEntrypoint {
  /** Import specifier for this entry (package name, or name/subpath). */
  entrypoint: string;
  /** Root-relative posix path of the resolved TypeScript source. */
  file: string;
}

/**
 * The boundary package's declared entrypoints resolved to TypeScript sources.
 * Wildcard subpaths are not enumerable and are omitted — callers must check
 * `boundary.exportSubpaths` for wildcards separately.
 */
export function boundaryEntrypoints(boundary: Boundary): BoundaryEntrypoint[] {
  const pkg = readPackageJson(boundary.dir);
  const name = boundary.packageName;
  if (!pkg || name === undefined) {
    return [];
  }
  const entries: BoundaryEntrypoint[] = [];
  for (const [subpath, target] of packageEntryTargets(pkg, boundary.dir)) {
    if (subpath.includes("*") || target.includes("*")) {
      continue;
    }
    entries.push({
      entrypoint: subpath === "" ? name : `${name}/${subpath}`,
      file: toPosix(
        path.relative(boundary.root, path.join(boundary.dir, target))
      ),
    });
  }
  return entries.sort((a, b) => a.entrypoint.localeCompare(b.entrypoint));
}

export function resolveBoundary(root: string, target: string): Boundary {
  let dir: string | undefined;
  const asPath = path.resolve(root, target);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
    dir = asPath;
  } else {
    for (const pattern of workspacePatterns(root)) {
      for (const candidate of expandPattern(root, pattern)) {
        if (readPackageJson(candidate)?.name === target) {
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
  dir = fs.realpathSync(dir);
  const relPath = toPosix(path.relative(root, dir));
  const pkg = readPackageJson(dir);
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

export function boundaryContains(
  boundary: Boundary,
  filePath: string
): boolean {
  const rel = path.relative(boundary.dir, filePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Classify an import module specifier reaching into the boundary.
 * Returns "public" when it goes through the package name and a declared
 * exports subpath (or the bare name), "deep" otherwise (relative paths,
 * aliases, undeclared subpaths).
 */
export function classifySpecifier(
  boundary: Boundary,
  specifier: string
): "public" | "deep" {
  const name = boundary.packageName;
  if (!name) {
    return "deep";
  }
  if (specifier === name) {
    return "public";
  }
  if (specifier.startsWith(`${name}/`)) {
    const subpath = specifier.slice(name.length + 1);
    const declared = boundary.exportSubpaths;
    if (declared === null) {
      return "deep";
    }
    if (declared.has(subpath)) {
      return "public";
    }
    for (const entry of declared) {
      if (!entry.includes("*")) {
        continue;
      }
      const [prefix, suffix] = entry.split("*");
      if (subpath.startsWith(prefix ?? "") && subpath.endsWith(suffix ?? "")) {
        return "public";
      }
    }
    return "deep";
  }
  return "deep";
}

const ownerCache = new Map<string, string>();
const workspaceDirsCache = new Map<string, Set<string> | null>();

/** Realpaths of the root's workspace package directories; null when the root declares none. */
function workspaceDirs(root: string): Set<string> | null {
  let dirs = workspaceDirsCache.get(root);
  if (dirs === undefined) {
    const patterns = workspacePatterns(root);
    dirs = patterns.length === 0 ? null : new Set();
    for (const pattern of patterns) {
      for (const dir of expandPattern(root, pattern)) {
        if (fs.existsSync(dir)) {
          dirs?.add(fs.realpathSync(dir));
        }
      }
    }
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
  const members = workspaceDirs(root);
  let dir = path.dirname(filePath);
  const visited: string[] = [];
  let owner: string | undefined;
  while (dir.startsWith(root) && dir !== root) {
    const cached = ownerCache.get(dir);
    if (cached !== undefined) {
      owner = cached;
      break;
    }
    visited.push(dir);
    const pkg = readPackageJson(dir);
    if (pkg && (members === null || members.has(fs.realpathSync(dir)))) {
      owner = pkg.name ?? toPosix(path.relative(root, dir));
      break;
    }
    dir = path.dirname(dir);
  }
  owner ??= "<root>";
  for (const seen of visited) {
    ownerCache.set(seen, owner);
  }
  return owner;
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
