import { basename, join, relative } from "#path";
import type { RepositoryReader } from "./boundary-manifest";
import { expandPattern, workspaceDeclaration } from "./boundary-manifest";
import { EXCLUDED_DIRS, toPosix } from "./boundary-model";
import type { Ignorer } from "./ignore-rules";
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

// Workspace discovery over a reader and gitignore answers.
// `semantics-discover.ts` answers them natively; `file-map-preparation.ts`
// from a recorded file map. Manifests and workspace files are parsed as
// data; no repository code runs.

/** Discovery's reads beyond the manifest rules': the entries of one directory. */
export interface DiscoveryReader extends RepositoryReader {
  /** The entries directly below `dir`; links are not directories. */
  entries(dir: string): { directory: boolean; name: string }[];
}

const hasTypeScriptSourcesPattern = /\.tsx?$/;

const GENERATED_DIRS = new Set([...EXCLUDED_DIRS, ".foundry"]);

function hasTypeScriptSources(
  reader: DiscoveryReader,
  dir: string,
  standalone = false
): boolean {
  const stack = [dir];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    for (const entry of reader.entries(next)) {
      if (entry.directory) {
        const nestedPackage =
          standalone && reader.exists(join(next, entry.name, "package.json"));
        if (
          !(
            GENERATED_DIRS.has(entry.name) ||
            entry.name.startsWith(".") ||
            nestedPackage
          )
        ) {
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
function skippedName(
  reader: DiscoveryReader,
  root: string,
  rel: string
): string | undefined {
  const manifest = join(root, rel, "package.json");
  if (!reader.exists(manifest)) {
    return;
  }
  try {
    return packageName(JSON.parse(reader.readFile(manifest)));
  } catch {
    // An unreadable manifest names no package.
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
 * The discovery, narrowed to a declared workspace or standalone package.
 * History can also record checkpoints with neither, as empty discoveries.
 */
export function requireDeclared(
  root: string,
  discovery: SemanticsDiscovery
): DeclaredDiscovery {
  const { declarationSource } = discovery;
  if (declarationSource === undefined) {
    throw new Error(
      `Directory ${root} has no workspace declaration or named TypeScript package. Spyglass reads pnpm-workspace.yaml, package.json#workspaces, or a standalone package.json.`
    );
  }
  return { ...discovery, declarationSource };
}

/**
 * The workspace root manifest's `name`, which a dataset records as its
 * workspace name; undefined without a root manifest or a string name. A
 * root manifest that does not parse raises its `SyntaxError`.
 */
export function workspaceRootName(
  reader: RepositoryReader,
  root: string
): string | undefined {
  const file = join(root, "package.json");
  if (!reader.exists(file)) {
    return undefined;
  }
  const parsed = JSON.parse(reader.readFile(file)) as { name?: unknown };
  return typeof parsed.name === "string" ? parsed.name : undefined;
}

/**
 * Every directory the workspace declaration's package patterns match is a
 * unit; it becomes an analyzable package when it has a named manifest and
 * TypeScript sources. Without a declaration, inspect the root package
 * itself. A directory two patterns match is inspected once, for the first.
 */
export function discoverUnitsWith(
  reader: DiscoveryReader,
  ignorer: Ignorer,
  root: string,
  config: Pick<SemanticsConfig, "exclude">
): SemanticsDiscovery {
  const declaration = workspaceDeclaration(reader, root);
  const patterns = declaration?.patterns ?? [];
  const inspection: Inspection = {
    excluded: new Set(config.exclude),
    excludedSeen: new Set(),
    ignorer,
    reader,
    root,
    skipped: [],
    units: [],
  };
  const seen = new Set<string>();
  const packagePatternsUnmatched: string[] = [];
  for (const pattern of patterns) {
    const matched = matchedDirectories(reader, root, pattern);
    if (matched.length === 0) {
      packagePatternsUnmatched.push(pattern);
    }
    for (const rel of matched.filter((path) => !seen.has(path))) {
      seen.add(rel);
      inspect(inspection, rel);
    }
  }
  // A standalone package is its own analysis root. Workspace declarations
  // retain precedence, so their root manifest never becomes another unit.
  if (declaration === undefined) {
    inspect(inspection, "");
  }
  inspection.units.sort(
    (a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path)
  );
  return {
    ...(declaration !== undefined &&
      patterns.length > 0 && { declarationSource: declaration.source }),
    ...(declaration === undefined &&
      (inspection.units.length > 0 ||
        inspection.skipped.some(
          (entry) => entry.reason === "analysis unsupported"
        )) && {
        declarationSource: "package.json" as const,
      }),
    excludeUnmatched: config.exclude.filter(
      (path) => !inspection.excludedSeen.has(path)
    ),
    packagePatterns: [...(declaration?.declared ?? [])],
    packagePatternsUnmatched,
    skipped: inspection.skipped.sort((a, b) => a.path.localeCompare(b.path)),
    units: inspection.units,
    unitsDiscovered:
      declaration === undefined ? inspection.units.length : seen.size,
  };
}

/**
 * The workspace-relative directories one pattern matches, sorted. Patterns
 * that resolve to the root or escape it never get here: the declaration
 * ignores them.
 */
function matchedDirectories(
  reader: DiscoveryReader,
  root: string,
  pattern: string
): string[] {
  return expandPattern(reader, root, pattern)
    .filter((dir) => reader.isDirectory(dir))
    .map((dir) => toPosix(relative(root, dir)))
    .sort();
}

interface Inspection {
  excluded: Set<string>;
  /** Exclusions some pattern matched, whether or not the unit was reached. */
  excludedSeen: Set<string>;
  ignorer: Ignorer;
  reader: DiscoveryReader;
  root: string;
  skipped: SemanticsSkippedDirectory[];
  units: SemanticsWorkspaceUnit[];
}

function inspect(inspection: Inspection, rel: string): void {
  const { excluded, ignorer, reader, root, skipped, units } = inspection;
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
    skip("generated output", skippedName(reader, root, rel));
    return;
  }
  if (ignorer.ignores(`${rel}/`)) {
    skip("gitignored", skippedName(reader, root, rel));
    return;
  }
  if (excluded.has(rel)) {
    skip("excluded", skippedName(reader, root, rel));
    return;
  }
  const manifestPath = rel === "" ? "package.json" : `${rel}/package.json`;
  const manifest = join(root, manifestPath);
  const parsed = reader.exists(manifest)
    ? (JSON.parse(reader.readFile(manifest)) as PackageManifest)
    : undefined;
  const id = parsed === undefined ? undefined : packageName(parsed);
  if (parsed === undefined || id === undefined) {
    skip("no package manifest");
    return;
  }
  if (!hasTypeScriptSources(reader, join(root, rel), rel === "")) {
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
