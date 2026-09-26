import * as fs from "node:fs";
import * as path from "node:path";
import { EXCLUDED_DIRS } from "./boundary";
import { createIgnorer } from "./ignore";
import type { SemanticsHistoryConfig } from "./semantics-history-types";
import type {
  SemanticsConfig,
  SemanticsDiscovery,
  SemanticsSkippedDirectory,
  SemanticsWorkspaceUnit,
} from "./semantics-types";

export const DEFAULT_HISTORY_CONFIG: SemanticsHistoryConfig = {
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

export const SEMANTICS_CONFIG_FILE = "foundry.config.json";

/** Reads `foundry.config.json#semantics` at the root when present; defaults otherwise. */
export function loadSemanticsConfig(root: string): SemanticsConfig {
  const file = path.join(root, SEMANTICS_CONFIG_FILE);
  if (!fs.existsSync(file)) {
    return DEFAULT_SEMANTICS_CONFIG;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
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

export function hasTypeScriptSources(dir: string): boolean {
  const stack = [dir];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    for (const entry of fs.readdirSync(next, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!(GENERATED_DIRS.has(entry.name) || entry.name.startsWith("."))) {
          stack.push(path.join(next, entry.name));
        }
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        return true;
      }
    }
  }
  return false;
}

function readName(manifest: string): string | undefined {
  const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
    name?: unknown;
  };
  return typeof parsed.name === "string" && parsed.name !== ""
    ? parsed.name
    : undefined;
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
    const dir = path.join(root, configured);
    if (!(fs.existsSync(dir) && fs.statSync(dir).isDirectory())) {
      rootsMissing.push(configured);
      continue;
    }
    rootsScanned.push(configured);
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
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
      const manifest = path.join(root, manifestPath);
      const id = fs.existsSync(manifest) ? readName(manifest) : undefined;
      if (id === undefined) {
        skip("no package manifest");
        continue;
      }
      if (!hasTypeScriptSources(path.join(root, rel))) {
        skip("analysis unsupported");
        continue;
      }
      units.push({
        analyzable: true,
        id,
        manifestPath,
        name: id,
        path: rel,
        root: configured,
      });
    }
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
