import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  EXCLUDED_DIRS,
  expandPattern,
  toPosix,
  workspaceDeclaration,
} from "./boundary";
import { createIgnorer, type Ignorer } from "./ignore";
import type {
  DeclaredDiscovery,
  SemanticsConfig,
  SemanticsDeclaredDependencies,
  SemanticsDeclaredDependencyKind,
  SemanticsDiscovery,
  SemanticsSkippedDirectory,
  SemanticsWorkspaceUnit,
} from "./semantics-types";
import { SEMANTICS_DECLARED_DEPENDENCY_KINDS } from "./semantics-types";

const hasTypeScriptSourcesPattern = /\.tsx?$/;

const GENERATED_DIRS = new Set([...EXCLUDED_DIRS, ".foundry"]);

function hasTypeScriptSources(dir: string): boolean {
  const stack = [dir];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!(GENERATED_DIRS.has(entry.name) || entry.name.startsWith("."))) {
          stack.push(join(next, entry.name));
        }
      } else if (
        hasTypeScriptSourcesPattern.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        return true;
      }
    }
  }
  return false;
}

type PackageManifest = Partial<
  Record<"name" | SemanticsDeclaredDependencyKind, unknown>
>;

function packageName(manifest: PackageManifest): string | undefined {
  return typeof manifest.name === "string" && manifest.name !== ""
    ? manifest.name
    : undefined;
}

/**
 * The name a skipped unit's `package.json` gives, so that a collection
 * counts the package as its workspace's. A skipped unit's manifest may be
 * anything, generated or ignored, so one that is missing or does not parse
 * gives no name rather than failing discovery.
 */
function skippedName(root: string, rel: string): string | undefined {
  const manifest = join(root, rel, "package.json");
  if (!existsSync(manifest)) {
    return;
  }
  try {
    return packageName(JSON.parse(readFileSync(manifest, "utf8")));
  } catch {
    // A manifest that does not parse names no package.
  }
}

/** The dependencies a `package.json` declares; a kind it lacks is omitted, and ranges stay as written. */
function declaredDependencies(
  manifest: PackageManifest
): SemanticsDeclaredDependencies {
  const declared: SemanticsDeclaredDependencies = {};
  for (const kind of SEMANTICS_DECLARED_DEPENDENCY_KINDS) {
    const ranges = manifest[kind];
    if (typeof ranges === "object" && ranges !== null) {
      declared[kind] = Object.fromEntries(
        Object.entries(ranges).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
    }
  }
  return declared;
}

/**
 * The discovery, narrowed to a workspace that declares package patterns; a
 * scan requires one and fails here otherwise. History does not: a
 * checkpoint from before the declaration existed is recorded with no
 * packages.
 */
export function requireDeclared(
  root: string,
  discovery: SemanticsDiscovery
): DeclaredDiscovery {
  const { declarationSource } = discovery;
  if (declarationSource === undefined) {
    throw new Error(
      `Workspace ${root} declares no packages. Atlas reads them from pnpm-workspace.yaml or package.json#workspaces.`
    );
  }
  return { ...discovery, declarationSource };
}

/**
 * Every directory the workspace declaration's package patterns match is a
 * unit; it becomes an analyzable package when it has a named manifest and
 * TypeScript sources. A directory two patterns match is inspected once, for
 * the first.
 */
export function discoverSemanticsUnits(
  root: string,
  config: SemanticsConfig
): SemanticsDiscovery {
  const declaration = workspaceDeclaration(root);
  const patterns = declaration?.patterns ?? [];
  const inspection: Inspection = {
    excluded: new Set(config.exclude),
    excludedSeen: new Set(),
    ignorer: createIgnorer(root),
    root,
    skipped: [],
    units: [],
  };
  const seen = new Set<string>();
  const packagePatternsUnmatched: string[] = [];
  for (const pattern of patterns) {
    const matched = matchedDirectories(root, pattern);
    if (matched.length === 0) {
      packagePatternsUnmatched.push(pattern);
    }
    for (const rel of matched.filter((path) => !seen.has(path))) {
      seen.add(rel);
      inspect(inspection, rel);
    }
  }
  inspection.units.sort(
    (a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path)
  );
  return {
    ...(declaration !== undefined &&
      patterns.length > 0 && { declarationSource: declaration.source }),
    excludeUnmatched: config.exclude.filter(
      (path) => !inspection.excludedSeen.has(path)
    ),
    packagePatterns: [...(declaration?.declared ?? [])],
    packagePatternsUnmatched,
    skipped: inspection.skipped.sort((a, b) => a.path.localeCompare(b.path)),
    units: inspection.units,
    unitsDiscovered: seen.size,
  };
}

/**
 * The workspace-relative directories one pattern matches, sorted. Patterns
 * that resolve to the root or escape it never get here: the declaration
 * ignores them.
 */
function matchedDirectories(root: string, pattern: string): string[] {
  return expandPattern(root, pattern)
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
    .map((dir) => toPosix(relative(root, dir)))
    .sort();
}

interface Inspection {
  excluded: Set<string>;
  /** Exclusions some pattern matched, whether or not the unit was reached. */
  excludedSeen: Set<string>;
  ignorer: Ignorer;
  root: string;
  skipped: SemanticsSkippedDirectory[];
  units: SemanticsWorkspaceUnit[];
}

function inspect(inspection: Inspection, rel: string): void {
  const { excluded, ignorer, root, skipped, units } = inspection;
  const skip = (
    reason: SemanticsSkippedDirectory["reason"],
    packageId?: string
  ): void => {
    skipped.push({
      ...(packageId !== undefined && { name: packageId }),
      path: rel,
      reason,
    });
  };
  if (excluded.has(rel)) {
    inspection.excludedSeen.add(rel);
  }
  const name = basename(rel);
  if (GENERATED_DIRS.has(name) || name.startsWith(".")) {
    skip("generated output", skippedName(root, rel));
    return;
  }
  if (ignorer.ignores(`${rel}/`)) {
    skip("gitignored", skippedName(root, rel));
    return;
  }
  if (excluded.has(rel)) {
    skip("excluded", skippedName(root, rel));
    return;
  }
  const manifestPath = `${rel}/package.json`;
  const manifest = join(root, manifestPath);
  const parsed = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, "utf8")) as PackageManifest)
    : undefined;
  const id = parsed === undefined ? undefined : packageName(parsed);
  if (parsed === undefined || id === undefined) {
    skip("no package manifest");
    return;
  }
  if (!hasTypeScriptSources(join(root, rel))) {
    skip("analysis unsupported", id);
    return;
  }
  units.push({
    analyzable: true,
    declaredDependencies: declaredDependencies(parsed),
    id,
    manifestPath,
    path: rel,
  });
}
