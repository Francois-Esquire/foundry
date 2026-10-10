import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXCLUDED_DIRS } from "./boundary";
import { createIgnorer, type Ignorer } from "./ignore";
import type { SemanticsHistoryConfig } from "./semantics-history-types";
import type {
  SemanticsConfig,
  SemanticsDeclaredDependencies,
  SemanticsDeclaredDependencyKind,
  SemanticsDiscovery,
  SemanticsSkippedDirectory,
  SemanticsWorkspaceUnit,
} from "./semantics-types";
import { SEMANTICS_DECLARED_DEPENDENCY_KINDS } from "./semantics-types";

const hasTypeScriptSourcesPattern = /\.tsx?$/;

const DEFAULT_HISTORY_CONFIG: SemanticsHistoryConfig = {
  checkpoints: 12,
  every: 100,
  range: "1y",
  strategy: "monthly",
};

export const DEFAULT_SEMANTICS_CONFIG: SemanticsConfig = {
  exclude: [],
  history: DEFAULT_HISTORY_CONFIG,
  output: ".foundry/semantics",
  roots: ["apps", "packages", "plugins", "tooling"],
};

const SEMANTICS_CONFIG_FILE = "foundry.config.json";

/** Reads `foundry.config.json#semantics` at the root when present; defaults otherwise. */
export function loadSemanticsConfig(root: string): SemanticsConfig {
  const file = join(root, SEMANTICS_CONFIG_FILE);
  if (!existsSync(file)) {
    return DEFAULT_SEMANTICS_CONFIG;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    semantics?: Partial<Omit<SemanticsConfig, "history">> & {
      history?: Partial<SemanticsHistoryConfig>;
    };
  };
  return {
    ...DEFAULT_SEMANTICS_CONFIG,
    ...parsed.semantics,
    history: { ...DEFAULT_HISTORY_CONFIG, ...parsed.semantics?.history },
  };
}

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

/** One level below each configured root; a unit is a named package manifest with TypeScript sources. */
export function discoverSemanticsUnits(
  root: string,
  config: SemanticsConfig
): SemanticsDiscovery {
  const excluded = new Set(config.exclude);
  const ignorer = createIgnorer(root);
  const units: SemanticsWorkspaceUnit[] = [];
  const skipped: SemanticsSkippedDirectory[] = [];
  const rootsScanned: string[] = [];
  const rootsMissing: string[] = [];
  let directoriesInspected = 0;
  for (const configured of [...config.roots].sort()) {
    const dir = join(root, configured);
    if (!(existsSync(dir) && statSync(dir).isDirectory())) {
      rootsMissing.push(configured);
      continue;
    }
    rootsScanned.push(configured);
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    directoriesInspected = discoverSemanticsUnitsName(
      entries,
      directoriesInspected,
      configured,
      skipped,
      ignorer,
      excluded,
      root,
      units
    );
  }
  units.sort(
    (a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path)
  );
  return {
    directoriesInspected,
    rootsMissing,
    rootsScanned,
    skipped,
    units,
  };
}

function discoverSemanticsUnitsName(
  entries: string[],
  initialDirectoriesInspected: number,
  configured: string,
  skipped: SemanticsSkippedDirectory[],
  ignorer: Ignorer,
  excluded: Set<string>,
  root: string,
  units: SemanticsWorkspaceUnit[]
) {
  let directoriesInspected = initialDirectoriesInspected;
  for (const name of entries) {
    directoriesInspected += 1;
    const rel = `${configured}/${name}`;
    const skip = (reason: SemanticsSkippedDirectory["reason"]): void => {
      skipped.push({ path: rel, reason });
    };
    if (GENERATED_DIRS.has(name) || name.startsWith(".")) {
      skip("generated output");
      continue;
    }
    if (ignorer.ignores(`${rel}/`)) {
      skip("gitignored");
      continue;
    }
    if (excluded.has(rel)) {
      skip("excluded");
      continue;
    }
    const manifestPath = `${rel}/package.json`;
    const manifest = join(root, manifestPath);
    const parsed = existsSync(manifest)
      ? (JSON.parse(readFileSync(manifest, "utf8")) as PackageManifest)
      : undefined;
    const id = parsed === undefined ? undefined : packageName(parsed);
    if (parsed === undefined || id === undefined) {
      skip("no package manifest");
      continue;
    }
    if (!hasTypeScriptSources(join(root, rel))) {
      skip("analysis unsupported");
      continue;
    }
    units.push({
      analyzable: true,
      declaredDependencies: declaredDependencies(parsed),
      id,
      manifestPath,
      path: rel,
      root: configured,
    });
  }
  return directoriesInspected;
}
