import * as fs from "node:fs";
import * as path from "node:path";
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

// Input fingerprints, two tiers since V12.6.
//
// Package-local (`packageLocalFingerprint`): the package's own TypeScript
// sources and manifest plus the local analysis stage version. Nothing else
// can change a local report — not the clock, not Git, not any other
// package — so nothing else is hashed.
//
// Workspace (`collectWorkspaceInputs` / `packageFingerprint`): the gate for
// the assembled report, whose derived half reads the whole workspace — one
// TypeScript program (external usage, concept evidence), one cruise of the
// module graph (gravity reach, change radius, every file an import can
// reach — manifests, styles, plain JS), one declaration index (overlap), and
// churn ranked against every tracked file's history. Every component is
// workspace-wide; packages differ only by identity. An assembled report is
// reusable exactly when nothing derivation can read has moved.

export interface WorkspaceInputs {
  /** `packageAnalysis` stage fingerprint: report schema and analysis policy. */
  analysis: string;
  /** Analysis clock every package is measured under, ISO-8601. */
  clock: string;
  /** Discovery roots, exclusions, and profile. */
  config: string;
  /** Root-relative posix path → content sha1 of every workspace input file, sorted. */
  files: Map<string, string>;
  /** Every commit hash in the root's history plus every tracked path, or the unavailability reason. */
  history: string;
  /** Hash of `files`. */
  sources: string;
}

// Type aliases, not interfaces: the cache stores components as
// `Record<string, string>`, and only an alias gets the implicit index signature.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type PackageFingerprintComponents = {
  analysis: string;
  config: string;
  clock: string;
  sources: string;
  history: string;
};

export interface PackageFingerprint {
  combined: string;
  components: PackageFingerprintComponents;
  packageId: string;
}

function hashFile(file: string): string {
  return sha1(fs.readFileSync(file, "utf8"));
}

function hashPairs(pairs: Iterable<[string, string]>): string {
  return sha1(JSON.stringify([...pairs]));
}

/** Manifests of every workspace package plus the root's: names, entries, exports, owners. */
function workspaceManifests(root: string): string[] {
  const manifests = [path.join(root, "package.json")];
  for (const pattern of workspacePatterns(root)) {
    for (const dir of expandPattern(root, pattern)) {
      const manifest = path.join(dir, "package.json");
      if (fs.existsSync(manifest)) {
        manifests.push(manifest);
      }
    }
  }
  return manifests;
}

/** Every module dependency-cruiser reaches from the workspace, root-relative posix. */
async function cruisedModules(
  root: string,
  units: SemanticsWorkspaceUnit[]
): Promise<string[]> {
  const first = units[0];
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
  config: SemanticsConfig;
  now: Date;
  profile?: AnalysisProfile;
  root: string;
  units: SemanticsWorkspaceUnit[];
}

/**
 * Everything a package analysis can read, hashed. One cruise and one Git log
 * for the whole workspace — a few seconds against minutes of analysis.
 */
export async function collectWorkspaceInputs(
  options: CollectWorkspaceInputsOptions
): Promise<WorkspaceInputs> {
  const { root, config, units, now } = options;
  const profile = options.profile ?? "full";
  const candidates = new Set<string>();
  for (const file of workspaceSourceFiles(root)) {
    candidates.add(toPosix(path.relative(root, file)));
  }
  for (const module of await cruisedModules(root, units)) {
    candidates.add(module);
  }
  for (const manifest of workspaceManifests(root)) {
    candidates.add(toPosix(path.relative(root, manifest)));
  }
  const files = new Map<string, string>();
  for (const rel of [...candidates].sort()) {
    const absolute = path.join(root, rel);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      files.set(rel, hashFile(absolute));
    }
  }

  const history = await collectGitHistory(root, { now });
  const historyInputs = history.available
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
    config: sha1(
      JSON.stringify({
        exclude: [...config.exclude].sort(),
        profile,
        roots: [...config.roots].sort(),
      })
    ),
    files,
    history: historyInputs,
    sources: hashPairs(files),
  };
}

export function packageFingerprint(
  inputs: WorkspaceInputs,
  unit: SemanticsWorkspaceUnit
): PackageFingerprint {
  const components: PackageFingerprintComponents = {
    analysis: inputs.analysis,
    clock: inputs.clock,
    config: inputs.config,
    history: inputs.history,
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

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type PackageLocalFingerprintComponents = {
  /** `packageLocalAnalysis` stage fingerprint: local report schema and analysis policy. */
  analysis: string;
  /** sha1 over the sorted (path, sha1) pairs of the package's own sources and manifest. */
  sources: string;
};

export interface PackageLocalFingerprint {
  combined: string;
  components: PackageLocalFingerprintComponents;
  /** Root-relative posix path → content sha1 of every local input, sorted. */
  files: Map<string, string>;
  packageId: string;
}

/**
 * The package-local cache key. Owned sources are enumerated by
 * `packageSourceFiles` — the same rule local analysis loads by — and hashes
 * are taken from `inputs.files` when the workspace pass already read them.
 */
export function packageLocalFingerprint(
  root: string,
  unit: SemanticsWorkspaceUnit,
  known = new Map<string, string>()
): PackageLocalFingerprint {
  const boundary = resolveBoundary(root, unit.path);
  const files = new Map<string, string>();
  const inputs = packageSourceFiles(root, boundary).map((file) =>
    toPosix(path.relative(root, file))
  );
  inputs.push(unit.manifestPath);
  for (const rel of inputs.sort()) {
    const absolute = path.join(root, rel);
    if (!fs.existsSync(absolute)) {
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

/** Start of the UTC day holding `date`: the default analysis clock. */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}
