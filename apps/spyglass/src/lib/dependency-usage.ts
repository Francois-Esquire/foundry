import type { DependencyEdge } from "./dependency-graph-types";
import type { DependencyInventory } from "./dependency-inventory-types";
import type { PackageLocalReport } from "./package-local-types";

interface UsageFiles {
  runtime: Set<string>;
  type: Set<string>;
}

/** Bare import roots match declarations, including scoped names and npm aliases. */
function importedPackage(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.includes(":")
  ) {
    return;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

function importEvidence(
  report: Pick<PackageLocalReport, "imports">
): Map<string, UsageFiles> {
  const names = new Map<string, UsageFiles>();
  for (const site of report.imports) {
    const name = importedPackage(site.specifier);
    if (site.scope !== "external" || name === undefined) {
      continue;
    }
    let files = names.get(name);
    if (files === undefined) {
      files = { runtime: new Set(), type: new Set() };
      names.set(name, files);
    }
    (site.typeOnly ? files.type : files.runtime).add(site.sourceModule);
  }
  return names;
}
function usage(
  files: UsageFiles | undefined
): NonNullable<DependencyEdge["usage"]> {
  const runtime = files?.runtime ?? new Set<string>();
  const type = files?.type ?? new Set<string>();
  return {
    importingFiles: [...new Set([...runtime, ...type])].sort(),
    runtimeFiles: [...runtime].sort(),
    typeOnlyFiles: [...type].filter((file) => !runtime.has(file)).sort(),
  };
}

/** This is static source evidence, not runtime execution or complete dynamic loading. */
export function enrichDependencyUsage(
  inventory: DependencyInventory,
  reports: ReadonlyMap<string, Pick<PackageLocalReport, "imports">>
): DependencyInventory {
  const evidence = new Map(
    [...reports].map(([id, report]) => [id, importEvidence(report)])
  );
  const { graph } = inventory;
  return {
    ...inventory,
    ...(graph !== undefined && {
      graph: {
        ...graph,
        edges: graph.edges.map((edge) => {
          const imports = evidence.get(edge.source);
          return imports === undefined
            ? edge
            : { ...edge, usage: usage(imports.get(edge.name)) };
        }),
      },
    }),
    usage: {
      analyzedPackages: inventory.packages
        .filter((pkg) => evidence.has(pkg.id))
        .map((pkg) => pkg.id)
        .sort(),
      method: "static-imports",
      unavailablePackages: inventory.packages
        .filter((pkg) => !evidence.has(pkg.id))
        .map((pkg) => pkg.id)
        .sort(),
    },
  };
}
