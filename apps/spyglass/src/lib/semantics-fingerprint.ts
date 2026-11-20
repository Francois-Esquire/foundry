import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  expandPattern,
  resolveBoundary,
  toPosix,
  workspacePatterns,
} from "./boundary";
import { collectCrossBoundaryEdges } from "./dependencies";
import { collectGitHistory } from "./git-history";
import { packageSourceFiles, workspaceSourceFiles } from "./project";
import { sha1, stageFingerprint } from "./semantics-stages";
import type {
  SemanticsConfig,
  SemanticsWorkspaceUnit,
} from "./semantics-types";
import type { AnalysisProfile } from "./types";

export interface WorkspaceInputs {
  analysis: string;
  clock: string;
  config: string;
  evolution: string;
  files: Map<string, string>;
  sources: string;
}

// biome-ignore lint/style/useConsistentTypeDefinitions: Cache components require the implicit Record<string, string> index signature of a type alias.
type PackageFingerprintComponents = {
  analysis: string;
  clock: string;
  config: string;
  evolution: string;
  sources: string;
};

export interface PackageFingerprint {
  combined: string;
  components: PackageFingerprintComponents;
  packageId: string;
}

function hashFile(file: string): string {
  return sha1(readFileSync(file, "utf8"));
}

function hashPairs(pairs: Iterable<[string, string]>): string {
  return sha1(JSON.stringify([...pairs]));
}

export function configFingerprint(inputs: {
  exclude: readonly string[];
  profile: AnalysisProfile;
}): string {
  return sha1(
    JSON.stringify({
      exclude: [...inputs.exclude].sort(),
      profile: inputs.profile,
    })
  );
}

function workspaceManifests(root: string): string[] {
  const manifests = [
    join(root, "package.json"),
    join(root, "pnpm-workspace.yaml"),
  ];
  for (const pattern of workspacePatterns(root)) {
    for (const dir of expandPattern(root, pattern)) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        manifests.push(manifest);
      }
    }
  }
  return manifests;
}

const FOUNDRY_DIRECTORY = ".foundry/";

async function cruisedModules(
  root: string,
  units: readonly Pick<SemanticsWorkspaceUnit, "path">[]
): Promise<string[]> {
  const [first] = units;
  if (first === undefined) {
    return [];
  }
  const edges = await collectCrossBoundaryEdges(
    root,
    resolveBoundary(root, first.path)
  );
  return edges.graph.modules;
}

export interface CollectWorkspaceInputsOptions {
  config: Pick<SemanticsConfig, "exclude">;
  now: Date;
  profile?: AnalysisProfile;
  root: string;
  units: readonly Pick<SemanticsWorkspaceUnit, "path">[];
}

export async function collectWorkspaceInputs(
  options: CollectWorkspaceInputsOptions
): Promise<WorkspaceInputs> {
  const { root, config, units, now } = options;
  const profile = options.profile ?? "full";
  const candidates = new Set<string>();
  for (const file of workspaceSourceFiles(root)) {
    candidates.add(toPosix(relative(root, file)));
  }
  for (const module of await cruisedModules(root, units)) {
    candidates.add(module);
  }
  for (const manifest of workspaceManifests(root)) {
    candidates.add(toPosix(relative(root, manifest)));
  }
  const files = new Map<string, string>();
  for (const rel of [...candidates].sort()) {
    if (rel.startsWith(FOUNDRY_DIRECTORY)) {
      continue;
    }
    const absolute = join(root, rel);
    if (existsSync(absolute) && statSync(absolute).isFile()) {
      files.set(rel, hashFile(absolute));
    }
  }

  const history = await collectGitHistory(root, { now });
  const evolution = history.available
    ? sha1(
        JSON.stringify({
          commits: history.commits.map((commit) => commit.hash),
          tracked: [...history.trackedFiles].sort(),
        })
      )
    : history.reason;

  return {
    analysis: stageFingerprint("packageAnalysis"),
    clock: now.toISOString(),
    config: configFingerprint({ exclude: config.exclude, profile }),
    evolution,
    files,
    sources: hashPairs(files),
  };
}

export function workspaceInputsHash(
  inputs: Pick<
    WorkspaceInputs,
    "analysis" | "clock" | "config" | "evolution" | "sources"
  >
): string {
  return sha1(
    JSON.stringify([
      inputs.analysis,
      inputs.clock,
      inputs.config,
      inputs.evolution,
      inputs.sources,
    ])
  );
}

export function packageFingerprint(
  inputs: WorkspaceInputs,
  unit: SemanticsWorkspaceUnit
): PackageFingerprint {
  const components: PackageFingerprintComponents = {
    analysis: inputs.analysis,
    clock: inputs.clock,
    config: inputs.config,
    evolution: inputs.evolution,
    sources: inputs.sources,
  };
  return {
    combined: sha1(JSON.stringify([unit.id, unit.path, components])).slice(
      0,
      16
    ),
    components,
    packageId: unit.id,
  };
}

// biome-ignore lint/style/useConsistentTypeDefinitions: Cache components require the implicit Record<string, string> index signature of a type alias.
type PackageLocalFingerprintComponents = {
  analysis: string;
  sources: string;
};

export interface PackageLocalFingerprint {
  combined: string;
  components: PackageLocalFingerprintComponents;
  files: Map<string, string>;
  packageId: string;
}

export function packageLocalFingerprint(
  root: string,
  unit: SemanticsWorkspaceUnit,
  known = new Map<string, string>()
): PackageLocalFingerprint {
  const boundary = resolveBoundary(root, unit.path);
  const files = new Map<string, string>();
  const inputs = packageSourceFiles(root, boundary).map((file) =>
    toPosix(relative(root, file))
  );
  inputs.push(unit.manifestPath);
  for (const rel of inputs.sort()) {
    const absolute = join(root, rel);
    if (!existsSync(absolute)) {
      continue;
    }
    files.set(rel, known.get(rel) ?? hashFile(absolute));
  }
  const components: PackageLocalFingerprintComponents = {
    analysis: stageFingerprint("packageLocalAnalysis"),
    sources: hashPairs(files),
  };
  return {
    combined: sha1(JSON.stringify([unit.id, unit.path, components])).slice(
      0,
      16
    ),
    components,
    files,
    packageId: unit.id,
  };
}

export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}
