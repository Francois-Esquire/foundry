import type { InternalResponsibilityReport } from "../lib/internal-responsibility-types";
import type { InternalPackageTopology } from "../lib/internal-topology-types";
import type {
  ArchitecturalScopeRef,
  SymbolLocalityReport,
} from "../lib/symbol-locality-types";
import type { ChurnReport } from "../lib/types";
import type { AtlasArchitecture } from "./architecture";
import type { AtlasFile } from "./types";

export interface AtlasInternals {
  architecture?: AtlasArchitecture;
  churn?: ChurnReport;
  fileIds: Record<string, string>;
  locality: SymbolLocalityReport;
  responsibilities: InternalResponsibilityReport;
  topology: InternalPackageTopology;
  unmatchedFiles: string[];
  unmatchedModules: string[];
}

export function bindInternals(
  topology: InternalPackageTopology,
  locality: SymbolLocalityReport,
  files: readonly Pick<AtlasFile, "id" | "path">[],
  responsibilities: InternalResponsibilityReport
): AtlasInternals {
  if (
    topology.package.id !== locality.package.id ||
    topology.package.root !== locality.package.root ||
    topology.package.id !== responsibilities.package.id ||
    topology.package.root !== responsibilities.package.root
  ) {
    throw new Error("Internal evidence must describe the same package");
  }
  const paths = new Map(files.map((file) => [file.path, file.id]));
  const fileIds: Record<string, string> = {};
  const unmatchedModules: string[] = [];
  for (const module of topology.modules) {
    const path = [topology.package.root, module.id].filter(Boolean).join("/");
    const fileId = paths.get(path);
    if (fileId === undefined) {
      unmatchedModules.push(module.id);
    } else {
      fileIds[module.id] = fileId;
    }
  }
  const mapped = new Set(Object.values(fileIds));
  return {
    fileIds,
    locality,
    responsibilities,
    topology,
    unmatchedFiles: files
      .filter((f) => !mapped.has(f.id))
      .map((f) => f.id)
      .sort(),
    unmatchedModules: unmatchedModules.sort(),
  };
}

export function scopeFileIds(
  internals: AtlasInternals,
  scope: ArchitecturalScopeRef
): string[] {
  return internals.topology.modules
    .filter((module) => {
      switch (scope.kind) {
        case "package":
          return scope.path === internals.topology.package.id;
        case "region":
          return module.region === scope.path;
        case "directory":
          return (
            scope.path === "." ||
            module.directory === scope.path ||
            module.directory.startsWith(`${scope.path}/`)
          );
        case "module":
          return module.id === scope.path;
        default:
          throw new Error("Unexpected scope.kind.");
      }
    })
    .flatMap((module) => internals.fileIds[module.id] ?? [])
    .sort();
}
