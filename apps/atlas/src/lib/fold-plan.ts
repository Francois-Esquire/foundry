import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { ts } from "ts-morph";
import { anchorBlocks, anchorFor } from "./anchors";
import type { Boundary } from "./boundary";
import { resolveBoundary, toPosix, workspacePatterns } from "./boundary";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import { classifyFile } from "./file-kind";
import { createIgnorer, type Ignorer } from "./ignore";
import type {
  FoldDestination,
  FoldFile,
  FoldPackagePlan,
  ModuleDependencyEdge,
  PackageMetadataImpact,
  PlanBlocker,
  PlannedChange,
  PlanStatus,
  ReductionOpportunity,
  SurfaceDependencies,
  SurfaceReport,
  SurfaceSymbol,
  UsageNamespace,
} from "./types";
import { planFingerprint } from "./validate";

const walkPattern = /\.tsx?$/;
const walkPattern2 = /\.config\.[cm]?[jt]sx?$/;

// Read-only fold planning: assembles the concrete shape of an existing
// fold-package opportunity — what crosses the boundary, what would become
// internal, what metadata is affected. Never decides fold eligibility
// (that is V2 policy) and never mutates anything.

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

function inventoryFiles(boundary: Boundary): FoldFile[] {
  const files: FoldFile[] = [];
  const ignorer = createIgnorer(boundary.root);
  const walk = (dir: string) => {
    walkEntry(dir, boundary, ignorer, walk, files);
  };
  walk(boundary.dir);
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

interface ManifestSections {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function walkEntry(
  dir: string,
  boundary: Boundary,
  ignorer: Ignorer,
  walk: (dir: string) => void,
  files: FoldFile[]
) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = toPosix(relative(boundary.root, abs));
    if (entry.isDirectory()) {
      if (!(SKIP_DIRS.has(entry.name) || ignorer.ignores(`${rel}/`))) {
        walk(abs);
      }
      continue;
    }
    if (ignorer.ignores(rel)) {
      continue;
    }
    if (walkPattern2.test(entry.name)) {
      files.push({ file: rel, kind: "config" });
    } else if (walkPattern.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      // Stories fold like source; the shared classifier decides test-ness.
      const kind = classifyFile(toPosix(relative(boundary.dir, abs)));
      files.push({ file: rel, kind: kind === "test" ? "test" : "source" });
    }
  }
}

function declaresDependency(manifestFile: string, name: string): boolean {
  if (!existsSync(manifestFile)) {
    return false;
  }
  const manifest = JSON.parse(
    readFileSync(manifestFile, "utf8")
  ) as ManifestSections;
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
  ].some((section) => section !== undefined && name in section);
}

/** tsconfig `references` entries pointing at the source package (JSONC-safe). */
function projectReferencesTo(tsconfigFile: string, sourceDir: string): boolean {
  if (!existsSync(tsconfigFile)) {
    return false;
  }
  const parsed = ts.readConfigFile(tsconfigFile, (file) =>
    ts.sys.readFile(file)
  );
  const config = parsed.config as
    | { references?: { path?: string }[] }
    | undefined;
  if (!config?.references) {
    return false;
  }
  return config.references.some(
    (reference) =>
      reference.path !== undefined &&
      resolve(dirname(tsconfigFile), reference.path) === sourceDir
  );
}

function resolveDestination(
  boundary: Boundary,
  destinationName: string
): { destination: FoldDestination; dir?: string } {
  let dest: Boundary | undefined;
  try {
    dest = resolveBoundary(boundary.root, destinationName);
  } catch {
    dest = undefined;
  }
  if (dest === undefined) {
    return {
      destination: { package: destinationName, resolution: "unresolved" },
    };
  }
  const shortName = (boundary.packageName ?? boundary.relPath).split("/").pop();
  const destination: FoldDestination = {
    package: destinationName,
    path: dest.relPath,
    resolution: "unresolved",
  };
  if (shortName !== undefined && existsSync(join(dest.dir, "src"))) {
    destination.directory = `src/${shortName}`;
    destination.resolution = existsSync(join(dest.dir, "src", shortName))
      ? "resolved"
      : "suggested";
  }
  return { destination, dir: dest.dir };
}

function collectMetadata(
  boundary: Boundary,
  sourceName: string,
  destinationName: string,
  destinationDir: string | undefined
): PackageMetadataImpact[] {
  const impacts: PackageMetadataImpact[] = [];
  const rel = (abs: string) => toPosix(relative(boundary.root, abs));

  const sourceManifest = join(boundary.dir, "package.json");
  if (existsSync(sourceManifest)) {
    impacts.push({
      detail: `${sourceName} package manifest defines the boundary being removed.`,
      file: rel(sourceManifest),
      kind: "source-manifest",
    });
  }
  const sourceTsconfig = join(boundary.dir, "tsconfig.json");
  if (existsSync(sourceTsconfig)) {
    impacts.push({
      detail: `${sourceName} TypeScript project configuration would be absorbed or removed.`,
      file: rel(sourceTsconfig),
      kind: "source-tsconfig",
    });
  }
  if (destinationDir !== undefined) {
    const destManifest = join(destinationDir, "package.json");
    if (declaresDependency(destManifest, sourceName)) {
      impacts.push({
        detail: `${destinationName} declares a dependency on ${sourceName}; removable after the fold.`,
        file: rel(destManifest),
        kind: "consumer-dependency",
      });
    }
    const destTsconfig = join(destinationDir, "tsconfig.json");
    if (projectReferencesTo(destTsconfig, boundary.dir)) {
      impacts.push({
        detail: `${destinationName} declares a TypeScript project reference to ${sourceName}.`,
        file: rel(destTsconfig),
        kind: "project-reference",
      });
    }
  }
  if (workspacePatterns(boundary.root).includes(boundary.relPath)) {
    impacts.push({
      detail: `Root workspace configuration lists ${boundary.relPath} explicitly.`,
      file: "package.json",
      kind: "workspace-entry",
    });
  }
  return impacts;
}

function fileCounts(files: FoldFile[]): string {
  const byKind = new Map<FoldFile["kind"], number>();
  for (const file of files) {
    byKind.set(file.kind, (byKind.get(file.kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const kind of ["source", "test", "config", "other"] as const) {
    const count = byKind.get(kind);
    if (count !== undefined) {
      parts.push(`${count} ${kind} file${count === 1 ? "" : "s"}`);
    }
  }
  return parts.join(", ");
}

export function buildFoldPlans(
  boundary: Boundary,
  symbols: SurfaceSymbol[],
  dependencies: SurfaceDependencies,
  opportunities: ReductionOpportunity[],
  config: AnalysisConfig = ANALYSIS_CONFIG
): FoldPackagePlan[] {
  const fold = opportunities.find(
    (opportunity) => opportunity.operation === "fold-package"
  );
  if (fold?.target === undefined) {
    return [];
  }

  const sourceName = boundary.packageName ?? boundary.relPath;
  const destinationName = fold.target.name;
  const [primary] = dependencies.incoming;

  const blockers: PlanBlocker[] = [];
  let status: PlanStatus = "ready";

  const { destination, dir: destinationDir } = resolveDestination(
    boundary,
    destinationName
  );
  if (destinationDir === undefined) {
    status = "unsupported";
    blockers.push({
      detail: `Destination ${destinationName} could not be resolved to a workspace package.`,
      reason: "destination-unresolved",
    });
  }
  if (primary?.package !== destinationName) {
    status = "blocked";
    blockers.push({
      detail: `The fold opportunity targets ${destinationName}, but current analysis identifies ${primary?.package ?? "no"} primary consumer.`,
      reason: "destination-mismatch",
    });
  }
  const anchor = anchorFor(boundary, config);
  if (anchor !== undefined && anchorBlocks("fold-package")) {
    if (status !== "unsupported") {
      status = "blocked";
    }
    blockers.push({
      detail: `Source package is an anchored boundary${anchor.reason === undefined ? "" : `: ${anchor.reason}`}.`,
      reason: "anchored-boundary",
    });
  }
  if (boundary.type !== "package" || boundary.packageName === undefined) {
    status = "unsupported";
    blockers.push({
      detail: `${boundary.relPath} is not a workspace package; package ownership of the fold source cannot be resolved.`,
      reason: "unresolved-package-ownership",
    });
  }

  const files = inventoryFiles(boundary);
  const dependencyEdges = primary?.moduleEdges ?? [];
  const consumedSurface = primary?.symbols ?? [];
  const usageNamespace: UsageNamespace = primary?.usageNamespace ?? "none";
  const boundaryUsage = {
    consumedSymbols: consumedSurface.length,
    importSites: primary?.importSites ?? 0,
    moduleEdges: dependencyEdges.length,
    usageNamespace,
  };
  const potentiallyInternalized = symbols
    .filter((symbol) => symbol.packagePublic)
    .map((symbol) => symbol.name)
    .sort((a, b) => a.localeCompare(b));
  const externalConsumers = dependencies.incoming
    .slice(1)
    .map((consumer) => consumer.package)
    .sort((a, b) => a.localeCompare(b));

  const metadata =
    status === "unsupported"
      ? []
      : collectMetadata(boundary, sourceName, destinationName, destinationDir);

  const plannedChanges: PlannedChange[] = [];
  buildFoldPlansEntries(
    status,
    boundary,
    plannedChanges,
    files,
    destinationName,
    dependencyEdges,
    boundaryUsage,
    sourceName,
    destination,
    potentiallyInternalized,
    metadata
  );

  const predictedDelta =
    status === "unsupported"
      ? { certain: {}, potential: {} }
      : {
          certain: {
            filesMoved: files.length,
            importSitesRewritten: boundaryUsage.importSites,
            packageBoundaries: -1,
            packageDependencyEdges: -1,
          },
          potential: {
            exportedSymbols: -potentiallyInternalized.length,
          },
        };

  const plan: Omit<FoldPackagePlan, "fingerprint"> = {
    blockers: blockers.sort(
      (a, b) =>
        a.reason.localeCompare(b.reason) || a.detail.localeCompare(b.detail)
    ),
    boundaryUsage,
    cautions: fold.cautions,
    consumedSurface,
    dependencyEdges,
    destination,
    evidence: fold.evidence,
    externalConsumers,
    files,
    id: `plan:${fold.id}`,
    operation: "fold-package",
    packageMetadata: metadata,
    plannedChanges,
    potentiallyInternalized,
    predictedDelta,
    source: { package: sourceName, path: boundary.relPath },
    status,
  };
  return [{ ...plan, fingerprint: planFingerprint(plan) }];
}

function buildFoldPlansEntries(
  status: PlanStatus,
  boundary: Boundary,
  plannedChanges: PlannedChange[],
  files: FoldFile[],
  destinationName: string,
  dependencyEdges: ModuleDependencyEdge[],
  boundaryUsage: {
    consumedSymbols: number;
    importSites: number;
    moduleEdges: number;
    usageNamespace: UsageNamespace;
  },
  sourceName: string,
  destination: FoldDestination,
  potentiallyInternalized: string[],
  metadata: PackageMetadataImpact[]
) {
  if (status !== "unsupported") {
    const sourceManifestRel = `${boundary.relPath}/package.json`;
    plannedChanges.push({
      description: `Move ${fileCounts(files)} into ${destinationName}.`,
      file: boundary.relPath,
      kind: "move-file",
    });
    const consumingModules = new Set(
      dependencyEdges.map((edge) => edge.fromFile)
    ).size;
    plannedChanges.push({
      description: `Rewrite ${boundaryUsage.importSites} import sites (${boundaryUsage.moduleEdges} module edges across ${consumingModules} modules) currently importing ${sourceName}.`,
      file: destination.path ?? boundary.relPath,
      kind: "rewrite-import",
    });
    plannedChanges.push({
      description: `Up to ${potentiallyInternalized.length} package-public symbols become internal to ${destinationName}.`,
      file: boundary.relPath,
      kind: "internalize-surface",
    });
    const visitImpact = () => {
      for (const impact of metadata) {
        if (impact.kind === "consumer-dependency") {
          plannedChanges.push({
            description: `Remove the ${sourceName} dependency from ${destinationName}.`,
            file: impact.file,
            kind: "remove-package-dependency",
          });
        } else if (impact.kind === "project-reference") {
          plannedChanges.push({
            description: `Update the TypeScript project reference pointing at ${sourceName}.`,
            file: impact.file,
            kind: "update-project-reference",
          });
        }
      }
    };
    visitImpact();
    plannedChanges.push({
      description: `Remove the ${sourceName} workspace package boundary.`,
      file: sourceManifestRel,
      kind: "remove-package-boundary",
    });
    const configFiles = files.filter((file) => file.kind === "config").length;
    if (configFiles > 0) {
      plannedChanges.push({
        description: `Review ${configFiles} source-package config file${configFiles === 1 ? "" : "s"}.`,
        file: boundary.relPath,
        kind: "review-config",
      });
    }
  }
}

/**
 * Select the fold plan built for a fold-package opportunity. Plans are
 * computed during analysis; this is the deterministic opportunity → plan
 * lookup.
 */
export function buildFoldPackagePlan(
  report: SurfaceReport,
  opportunity: ReductionOpportunity
): FoldPackagePlan {
  if (opportunity.operation !== "fold-package") {
    throw new Error(
      `buildFoldPackagePlan only selects fold-package plans (got ${opportunity.operation})`
    );
  }
  const plan = report.plans.find(
    (candidate): candidate is FoldPackagePlan =>
      candidate.operation === "fold-package" &&
      candidate.source.package === opportunity.subject.id
  );
  if (plan === undefined) {
    throw new Error(`No plan found for opportunity ${opportunity.id}`);
  }
  return plan;
}
