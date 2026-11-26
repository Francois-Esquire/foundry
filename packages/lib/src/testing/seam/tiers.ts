import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  DEPENDENCY_FIELDS,
  type PackageManifest,
  packageDirectories,
  readManifest,
} from "./manifest";

export type PackageTier = "primitives" | "tools" | "domains";

export const PACKAGE_TIERS: Readonly<Record<string, PackageTier>> = {
  "@foundry/agents": "domains",
  "@foundry/artifacts": "domains",
  "@foundry/core": "primitives",
  "@foundry/lib": "primitives",
  "@foundry/models": "tools",
  "@foundry/modules": "domains",
  "@foundry/prompts": "tools",
  "@foundry/queue": "domains",
  "@foundry/sandbox": "domains",
  "@foundry/scheduling": "domains",
  "@foundry/tasks": "domains",
  "@foundry/usage": "tools",
  "@foundry/workflows": "domains",
  "@foundry/workspaces": "domains",
};

const TIER_RANK: Readonly<Record<PackageTier, number>> = {
  domains: 2,
  primitives: 0,
  tools: 1,
};

const UNTIERED_WORKSPACE_PACKAGES: ReadonlySet<string> = new Set([
  "@foundry/tsconfig",
]);

function foundryDependencies(manifest: PackageManifest): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (
        name.startsWith("@foundry/") &&
        !UNTIERED_WORKSPACE_PACKAGES.has(name)
      ) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    const onPath = path.indexOf(name);
    if (onPath >= 0) {
      return [...path.slice(onPath), name];
    }
    if (done.has(name)) {
      return null;
    }
    path.push(name);
    for (const dependency of graph.get(name) ?? []) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    done.add(name);
    return null;
  };
  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) {
      return cycle;
    }
  }
  return [];
}

function auditDependencyTiers(
  name: string,
  dependencies: readonly string[],
  graph: ReadonlyMap<string, readonly string[]>,
  tiers: Readonly<Record<string, PackageTier>>
): string[] {
  const tier = tiers[name];
  const violations: string[] = [];
  for (const dependency of dependencies) {
    const dependencyTier = tiers[dependency];
    if (!graph.has(dependency)) {
      violations.push(`${name}: depends on ${dependency} outside packages/*`);
    } else if (tier && dependencyTier === undefined) {
      violations.push(`${name}: depends on unclassified ${dependency}`);
    } else if (
      tier &&
      dependencyTier &&
      TIER_RANK[dependencyTier] > TIER_RANK[tier]
    ) {
      violations.push(
        `${name} (${tier}) must not depend on ${dependency} (${dependencyTier})`
      );
    }
  }
  return violations;
}

function readPackageGraph(
  packagesDir: string,
  violations: string[]
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const dir of packageDirectories(packagesDir)) {
    const label = relative(resolve(packagesDir, ".."), dir);
    if (!existsSync(join(dir, "package.json"))) {
      violations.push(`${label}: missing package.json`);
      continue;
    }
    const manifest = readManifest(dir);
    graph.set(manifest.name ?? label, foundryDependencies(manifest));
  }
  return graph;
}

export function auditPackageTiers(
  packagesDir: string,
  tiers: Readonly<Record<string, PackageTier>> = PACKAGE_TIERS
): string[] {
  const violations: string[] = [];
  const graph = readPackageGraph(resolve(packagesDir), violations);

  for (const name of graph.keys()) {
    if (!(name in tiers)) {
      violations.push(`${name}: not classified in PACKAGE_TIERS`);
    }
  }
  for (const name of Object.keys(tiers)) {
    if (!graph.has(name)) {
      violations.push(`${name}: classified in PACKAGE_TIERS but not found`);
    }
  }
  for (const [name, dependencies] of graph) {
    violations.push(...auditDependencyTiers(name, dependencies, graph, tiers));
  }

  const cycle = findCycle(graph);
  if (cycle.length > 0) {
    violations.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  return violations;
}

export function assertPackageTiers(packagesDir: string): void {
  const violations = auditPackageTiers(packagesDir);
  if (violations.length > 0) {
    throw new Error(`Package tier violations:\n- ${violations.join("\n- ")}`);
  }
}
