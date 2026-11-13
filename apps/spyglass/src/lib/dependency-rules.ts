import { basename, join } from "#path";
import type { RepositoryReader } from "./boundary-manifest";
import type {
  DependencyEdge,
  DependencyNode,
  ResolvedDependencyGraph,
} from "./dependency-graph-types";
import type {
  DependencyInventory,
  DependencyInventoryPackage,
} from "./dependency-inventory-types";
import type {
  DeclaredDiscovery,
  SemanticsDeclaredDependencies,
} from "./semantics-types";
import { SEMANTICS_DECLARED_DEPENDENCY_KINDS } from "./semantics-types";

// The dependency inventory and its resolution against `bun.lock`, over a
// reader. `dependency-inventory.ts` and `dependency-graph.ts` answer them
// natively; the file-map dataset from a recorded file map. Manifests and the
// lockfile are read as data: nothing is installed and no script runs.

/**
 * Parses JSON with comments and trailing commas, as TypeScript's
 * `parseConfigFileTextToJson`; `error` is set when the text does not parse.
 */
export type JsoncParser = (
  fileName: string,
  text: string
) => { config?: unknown; error?: unknown };

function manifestDependencies(
  manifest: Record<string, unknown>
): SemanticsDeclaredDependencies {
  const declared: SemanticsDeclaredDependencies = {};
  for (const kind of SEMANTICS_DECLARED_DEPENDENCY_KINDS) {
    const ranges = manifest[kind];
    if (
      typeof ranges === "object" &&
      ranges !== null &&
      !Array.isArray(ranges)
    ) {
      declared[kind] = Object.fromEntries(
        Object.entries(ranges).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
    }
  }
  return declared;
}

function readPackage(
  reader: RepositoryReader,
  root: string,
  path: string,
  role: DependencyInventoryPackage["role"],
  analysis: DependencyInventoryPackage["analysis"]
): DependencyInventoryPackage {
  const manifest = JSON.parse(
    reader.readFile(join(root, path, "package.json"))
  ) as Record<string, unknown>;
  const name =
    typeof manifest.name === "string" ? manifest.name : basename(root);
  const optionalPeers = Object.entries(
    (manifest.peerDependenciesMeta ?? {}) as Record<string, unknown>
  )
    .filter(
      ([, value]) =>
        typeof value === "object" &&
        value !== null &&
        "optional" in value &&
        value.optional === true
    )
    .map(([peer]) => peer)
    .sort();
  return {
    analysis,
    ...(optionalPeers.length > 0 && { optionalPeers }),
    declaredDependencies: manifestDependencies(manifest),
    id: role === "root" ? "workspace-root:" : name,
    name,
    path,
    role,
    ...(typeof manifest.version === "string" && { version: manifest.version }),
  };
}

/** Reuse discovery's exclusions; only source-language coverage is broadened. */
export function collectDependencyInventoryWith(
  reader: RepositoryReader,
  root: string,
  discovery: DeclaredDiscovery
): DependencyInventory {
  const packages = discovery.units.map((unit) =>
    readPackage(reader, root, unit.path, "workspace", "available")
  );
  for (const skipped of discovery.skipped) {
    if (
      skipped.reason === "analysis unsupported" &&
      skipped.name !== undefined
    ) {
      packages.push(
        readPackage(reader, root, skipped.path, "workspace", "unsupported")
      );
    }
  }
  if (
    discovery.declarationSource !== "package.json" &&
    reader.exists(join(root, "package.json"))
  ) {
    packages.push(readPackage(reader, root, "", "root", "unsupported"));
  }
  return {
    packages: packages.sort((a, b) => a.id.localeCompare(b.id)),
    schemaVersion: 1,
    skipped: discovery.skipped.filter(
      (entry) => entry.reason !== "analysis unsupported"
    ),
  };
}

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
function readLock(
  reader: RepositoryReader,
  parseJsonc: JsoncParser,
  root: string,
  issues: string[]
): LockData | undefined {
  const path = join(root, "bun.lock");
  if (!reader.exists(path)) {
    issues.push(
      "No bun.lock: declarations are available, installed dependency resolution is not."
    );
    return;
  }
  const parsed = parseJsonc("bun.lock", reader.readFile(path));
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

/**
 * Read saved installation evidence without installing packages or guessing
 * versions. `parseJsonc` reads `bun.lock`'s text as JSON with comments and
 * trailing commas, as TypeScript's config parser does.
 */
export function resolveDependencyGraphWith(
  reader: RepositoryReader,
  root: string,
  inventory: DependencyInventory,
  parseJsonc: JsoncParser
): ResolvedDependencyGraph {
  const issues: string[] = [];
  const lock = readLock(reader, parseJsonc, root, issues);
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
