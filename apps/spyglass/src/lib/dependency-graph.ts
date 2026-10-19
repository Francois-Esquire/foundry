import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigFileTextToJson } from "typescript";
import type {
  DependencyEdge,
  DependencyNode,
  ResolvedDependencyGraph,
} from "./dependency-graph-types";
import { manifestDependencies } from "./dependency-inventory";
import type {
  DependencyInventory,
  DependencyInventoryPackage,
} from "./dependency-inventory-types";
import { SEMANTICS_DECLARED_DEPENDENCY_KINDS } from "./semantics-types";

interface LockData {
  packages: Record<string, unknown>;
  workspaces: Record<string, unknown>;
}
interface LockEntry {
  locator: string;
  metadata: Record<string, unknown>;
  node: DependencyNode;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function readLock(root: string, issues: string[]): LockData | undefined {
  const path = join(root, "bun.lock");
  if (!existsSync(path)) {
    issues.push(
      "No bun.lock: declarations are available, installed dependency resolution is not."
    );
    return;
  }
  const parsed = parseConfigFileTextToJson(
    "bun.lock",
    readFileSync(path, "utf8")
  );
  const data = record(parsed.config);
  const packages = record(data?.packages);
  const workspaces = record(data?.workspaces);
  if (
    parsed.error !== undefined ||
    data?.lockfileVersion !== 1 ||
    packages === undefined ||
    workspaces === undefined
  ) {
    issues.push(
      "Unsupported or unreadable bun.lock; this reader supports text lockfileVersion 1."
    );
    return;
  }
  return { packages, workspaces };
}
function lockEntries(
  lock: LockData,
  inventory: DependencyInventory,
  issues: string[]
): LockEntry[] {
  const byPath = new Map(inventory.packages.map((pkg) => [pkg.path, pkg]));
  const entries: LockEntry[] = [];
  for (const [locator, raw] of Object.entries(lock.packages)) {
    if (!Array.isArray(raw) || typeof raw[0] !== "string") {
      issues.push(`Unreadable lock entry: ${locator}`);
      continue;
    }
    const [descriptor] = raw;
    const separator = descriptor.indexOf("@", 1);
    if (separator < 0) {
      issues.push(`Unsupported lock descriptor: ${locator}`);
      continue;
    }
    const name = descriptor.slice(0, separator);
    const version = descriptor.slice(separator + 1);
    if (version.startsWith("workspace:")) {
      const pkg = byPath.get(version.slice("workspace:".length));
      if (pkg !== undefined && pkg.name !== name) {
        issues.push(
          `Workspace identity differs from bun.lock: ${pkg.path} is ${pkg.name}, locked as ${name}`
        );
        continue;
      }
      if (pkg !== undefined) {
        entries.push({
          locator,
          metadata: {},
          node: {
            id: pkg.id,
            kind: "workspace",
            name: pkg.name,
            ...(pkg.version !== undefined && { version: pkg.version }),
          },
        });
      }
      continue;
    }
    const metadata = record(raw[2]);
    if (metadata === undefined) {
      issues.push(`Missing dependency metadata: ${locator}`);
    }
    entries.push({
      locator,
      metadata: metadata ?? {},
      node: { id: `lock:${locator}`, kind: "external", locator, name, version },
    });
  }
  return entries;
}

/** Walk Bun's nested install locators, respecting scoped package segments. */
function parentLocator(locator: string): string {
  const parts = locator.split("/");
  parts.pop();
  if (parts.at(-1)?.startsWith("@")) {
    parts.pop();
  }
  return parts.join("/");
}
function resolveTarget(
  locator: string,
  name: string,
  byLocator: Map<string, LockEntry>
): string | undefined {
  let parent = locator;
  while (parent !== "") {
    const found = byLocator.get(`${parent}/${name}`);
    if (found !== undefined) {
      return found.node.id;
    }
    parent = parentLocator(parent);
  }
  return byLocator.get(name)?.node.id;
}
function edgesFor(
  source: string,
  locator: string,
  metadata: Record<string, unknown>,
  byLocator: Map<string, LockEntry>
): DependencyEdge[] {
  const declarations = manifestDependencies(metadata);
  const optionalPeers = Array.isArray(metadata.optionalPeers)
    ? metadata.optionalPeers
    : [];
  const peerMeta = record(metadata.peerDependenciesMeta);
  const edges: DependencyEdge[] = [];
  for (const kind of SEMANTICS_DECLARED_DEPENDENCY_KINDS) {
    for (const [name, range] of Object.entries(declarations[kind] ?? {}).sort(
      ([a], [b]) => a.localeCompare(b)
    )) {
      const target = resolveTarget(locator, name, byLocator);
      const optional =
        kind === "optionalDependencies" ||
        (kind === "peerDependencies" &&
          (optionalPeers.includes(name) ||
            record(peerMeta?.[name])?.optional === true));
      edges.push({
        kind,
        name,
        range,
        resolution: target === undefined ? "unresolved" : "resolved",
        source,
        ...(target !== undefined && { target }),
        ...(optional && { optional }),
      });
    }
  }
  return edges;
}
function workspaceEdges(
  pkg: DependencyInventoryPackage,
  lock: LockData | undefined,
  byLocator: Map<string, LockEntry>,
  issues: string[]
): DependencyEdge[] {
  const saved = record(lock?.workspaces[pkg.path]);
  const edges = edgesFor(
    pkg.id,
    pkg.role === "root" ? "" : pkg.name,
    { ...pkg.declaredDependencies, optionalPeers: pkg.optionalPeers },
    byLocator
  );
  const locked = manifestDependencies(saved ?? {});
  const identityChanged =
    lock !== undefined && pkg.role === "workspace" && saved?.name !== pkg.name;
  if (identityChanged) {
    issues.push(
      `Workspace manifest identity differs from bun.lock: ${pkg.path} is ${pkg.name}`
    );
  }
  for (const edge of edges) {
    if (
      identityChanged ||
      (lock !== undefined && locked[edge.kind]?.[edge.name] !== edge.range)
    ) {
      edge.target = undefined;
      edge.resolution = "unresolved";
      issues.push(
        `Manifest differs from bun.lock: ${pkg.name} ${edge.kind}.${edge.name}`
      );
    }
  }
  return edges;
}

/** Read saved installation evidence without installing packages or guessing versions. */
export function resolveDependencyGraph(
  root: string,
  inventory: DependencyInventory
): ResolvedDependencyGraph {
  const issues: string[] = [];
  const lock = readLock(root, issues);
  const entries =
    lock === undefined ? [] : lockEntries(lock, inventory, issues);
  const byLocator = new Map(entries.map((entry) => [entry.locator, entry]));
  const nodes: DependencyNode[] = inventory.packages.map((pkg) => ({
    id: pkg.id,
    kind: "workspace",
    name: pkg.name,
    ...(pkg.version !== undefined && { version: pkg.version }),
  }));
  const edges = inventory.packages.flatMap((pkg) =>
    workspaceEdges(pkg, lock, byLocator, issues)
  );
  for (const entry of entries) {
    if (entry.node.kind === "workspace") {
      continue;
    }
    nodes.push(entry.node);
    edges.push(
      ...edgesFor(entry.node.id, entry.locator, entry.metadata, byLocator)
    );
  }
  const workspaceByName = new Map(
    inventory.packages.map((pkg) => [pkg.name, pkg])
  );
  for (const edge of edges) {
    if (
      edge.range.startsWith("workspace:") &&
      edge.resolution === "unresolved"
    ) {
      const target = workspaceByName.get(edge.name);
      if (target !== undefined) {
        edge.target = target.id;
        edge.resolution = "resolved";
      }
    }
  }
  const unresolved = edges.filter(
    (edge) => edge.resolution === "unresolved"
  ).length;
  if (unresolved > 0) {
    issues.push(
      `${unresolved} dependency declarations have no confirmed target (including absent optional or peer requirements).`
    );
  }
  let status: ResolvedDependencyGraph["resolution"]["status"] =
    issues.length > 0 ? "partial" : "complete";
  if (lock === undefined) {
    status = "unavailable";
  }
  return {
    edges,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    resolution: {
      issues,
      ...(lock !== undefined && { source: "bun.lock" as const }),
      status,
    },
    schemaVersion: 1,
  };
}
