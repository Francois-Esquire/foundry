import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  DependencyInventory,
  DependencyInventoryPackage,
} from "./dependency-inventory-types";
import type {
  DeclaredDiscovery,
  SemanticsDeclaredDependencies,
} from "./semantics-types";
import { SEMANTICS_DECLARED_DEPENDENCY_KINDS } from "./semantics-types";

export function manifestDependencies(
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
  root: string,
  path: string,
  role: DependencyInventoryPackage["role"],
  analysis: DependencyInventoryPackage["analysis"]
): DependencyInventoryPackage {
  const manifest = JSON.parse(
    readFileSync(join(root, path, "package.json"), "utf8")
  ) as Record<string, unknown>;
  const name =
    typeof manifest.name === "string" ? manifest.name : basename(root);
  return {
    analysis,
    declaredDependencies: manifestDependencies(manifest),
    id: role === "root" ? "workspace-root:" : name,
    name,
    path,
    role,
    ...(typeof manifest.version === "string" && { version: manifest.version }),
  };
}

/** Reuse discovery's exclusions; only source-language coverage is broadened. */
export function collectDependencyInventory(
  root: string,
  discovery: DeclaredDiscovery
): DependencyInventory {
  const packages = discovery.units.map((unit) =>
    readPackage(root, unit.path, "workspace", "available")
  );
  for (const skipped of discovery.skipped) {
    if (
      skipped.reason === "analysis unsupported" &&
      skipped.name !== undefined
    ) {
      packages.push(
        readPackage(root, skipped.path, "workspace", "unsupported")
      );
    }
  }
  if (
    discovery.declarationSource !== "package.json" &&
    existsSync(join(root, "package.json"))
  ) {
    packages.push(readPackage(root, "", "root", "unsupported"));
  }
  return {
    packages: packages.sort((a, b) => a.id.localeCompare(b.id)),
    schemaVersion: 1,
    skipped: discovery.skipped.filter(
      (entry) => entry.reason !== "analysis unsupported"
    ),
  };
}
