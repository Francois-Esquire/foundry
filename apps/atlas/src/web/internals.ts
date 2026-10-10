import type { InternalResponsibilityReport } from "../lib/internal-responsibility-types";
import type { InternalPackageTopology } from "../lib/internal-topology-types";
import type {
  FileRole,
  FileRolesPackage,
} from "../lib/lenses/file-roles-types";
import type {
  FrequentChangeFile,
  FrequentChangeGate,
  FrequentChangeHistory,
} from "../lib/lenses/frequent-change-types";
import { rootRelative } from "../lib/lenses/package-internals";
import type {
  ArchitecturalScopeRef,
  SymbolLocalityReport,
} from "../lib/symbol-locality-types";
import type { AtlasArchitecture } from "./architecture";
import type { AtlasFile } from "./types";

/** One island's frequently changed files, from the `frequent-change` lens, with the gate that chose them and the history they were read from. */
interface PackageFrequentChange {
  available: true;
  files: readonly FrequentChangeFile[];
  gate: FrequentChangeGate;
  history: FrequentChangeHistory;
}

/** Why an island shows no recorded change: its package has no Git history in this survey, or the dataset was saved before the lens. */
interface NoFrequentChange {
  available: false;
  reason: "no-history" | "not-saved";
}

export type FrequentChangeEvidence = PackageFrequentChange | NoFrequentChange;

export interface AtlasInternals {
  architecture?: AtlasArchitecture;
  fileIds: Record<string, string>;
  /** Each file's role from the `file-roles` lens, by file id; a file without one is absent. */
  fileRoles: Record<string, FileRole>;
  /** Recorded change, read only when the layer is on. */
  frequentChange?: FrequentChangeEvidence;
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
  responsibilities: InternalResponsibilityReport,
  roles: Pick<FileRolesPackage, "modules"> | undefined
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
    const fileId = paths.get(rootRelative(topology.package.root, module.id));
    if (fileId === undefined) {
      unmatchedModules.push(module.id);
    } else {
      fileIds[module.id] = fileId;
    }
  }
  const mapped = new Set(Object.values(fileIds));
  const fileRoles: Record<string, FileRole> = {};
  for (const module of roles?.modules ?? []) {
    const fileId = paths.get(module.module);
    if (fileId !== undefined && module.role !== undefined) {
      fileRoles[fileId] = module.role;
    }
  }
  return {
    fileIds,
    fileRoles,
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

/** `files` with the `file-roles` lens's role each holds, for role marks; the input is not changed. */
export function withFileRoles(
  internals: Pick<AtlasInternals, "fileRoles">,
  files: readonly AtlasFile[]
): AtlasFile[] {
  return files.map((file) => {
    const fileRole = internals.fileRoles[file.id];
    return fileRole ? { ...file, fileRole } : file;
  });
}
