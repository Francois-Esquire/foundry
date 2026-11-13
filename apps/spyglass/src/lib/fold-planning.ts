import { dirname, join, relative, resolve } from "#path";

import { anchorBlocks, anchorFor } from "./anchors";
import type { Boundary } from "./boundary-model";
import { toPosix } from "./boundary-model";
import type { AnalysisConfig } from "./config";
import { classifyFile } from "./file-kind";
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
//
// Planning reads the repository only through `FoldInputs`: the answers the
// native planner's reads give, taken before planning runs (`fold-plan.ts`
// reads them). A read that throws keeps its error, which planning rethrows
// where the native planner would have raised it, so an unused failure stays
// harmless.

/** A native read's answer, or the error the read raised. */
export type FoldRead<T> = { readonly value: T } | { readonly error: unknown };

/** The dependency sections of a manifest, as parsed and unvalidated. */
export interface ManifestSections {
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
}

/** What planning reads about a package being folded. */
export interface FoldSourceInput {
  /**
   * Root-relative posix path of every non-directory entry the package walk
   * reaches, sorted: below the package directory, outside `SKIP_DIRS` and
   * gitignored paths. Classification happens during planning.
   */
  readonly files: FoldRead<readonly string[]>;
  readonly hasManifest: boolean;
  readonly hasTsconfig: boolean;
}

/** What planning reads about a destination `resolveBoundary` resolved. */
export interface FoldDestinationInput {
  /** Real directory of the destination boundary. */
  readonly dir: string;
  /** Whether `src` exists below `dir`. */
  readonly hasSrc: boolean;
  /** The manifest's dependency sections; absent without a manifest. */
  readonly manifest?: FoldRead<ManifestSections>;
  readonly relPath: string;
  /**
   * Whether `src/<short name>` exists, for the short name of each prepared
   * source package. Empty when `src` does not exist.
   */
  readonly srcEntries: ReadonlyMap<string, boolean>;
  /** `tsconfig.json`'s `references`, unvalidated; absent without the file. */
  readonly tsconfig?: { readonly references: unknown };
}

/**
 * Every repository answer fold planning needs for a set of source packages
 * and candidate destination names, keyed in sorted order. A destination
 * that does not resolve is `null`. Planning throws for a source or
 * destination these inputs do not cover.
 */
export interface FoldInputs {
  /** Destination answers by boundary name. */
  readonly destinations: ReadonlyMap<string, FoldDestinationInput | null>;
  readonly root: string;
  /** Source answers by real package directory. */
  readonly sources: ReadonlyMap<string, FoldSourceInput>;
  /** `workspacePatterns(root)`. */
  readonly workspacePatterns: FoldRead<readonly string[]>;
}

function answerOf<T>(read: FoldRead<T>): T {
  if ("error" in read) {
    throw read.error;
  }
  return read.value;
}

export function shortNameOf(boundary: Boundary): string | undefined {
  return (boundary.packageName ?? boundary.relPath).split("/").pop();
}

/** The fold-package opportunity a plan is built for, if any. */
export function foldOpportunity(
  opportunities: readonly ReductionOpportunity[]
): ReductionOpportunity | undefined {
  return opportunities.find(
    (opportunity) => opportunity.operation === "fold-package"
  );
}

function sourceInput(inputs: FoldInputs, boundary: Boundary): FoldSourceInput {
  if (boundary.root !== inputs.root) {
    throw new Error(`Fold inputs are for ${inputs.root}, not ${boundary.root}`);
  }
  const input = inputs.sources.get(boundary.dir);
  if (input === undefined) {
    throw new Error(`No prepared fold source for ${boundary.dir}`);
  }
  return input;
}

function inventoryFiles(
  boundary: Boundary,
  source: FoldSourceInput
): FoldFile[] {
  const files: FoldFile[] = [];
  for (const rel of answerOf(source.files)) {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (walkPattern2.test(name)) {
      files.push({ file: rel, kind: "config" });
    } else if (walkPattern.test(name) && !name.endsWith(".d.ts")) {
      // Stories fold like source; the shared classifier decides test-ness.
      const local = relative(boundary.dir, join(boundary.root, rel));
      const kind = classifyFile(toPosix(local));
      files.push({ file: rel, kind: kind === "test" ? "test" : "source" });
    }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

function declaresDependency(
  manifest: FoldRead<ManifestSections> | undefined,
  name: string
): boolean {
  if (manifest === undefined) {
    return false;
  }
  const sections = answerOf(manifest);
  return [
    sections.dependencies,
    sections.devDependencies,
    sections.peerDependencies,
  ].some(
    (section) =>
      section !== undefined && name in (section as Record<string, unknown>)
  );
}

function projectReferencesTo(
  destination: FoldDestinationInput,
  sourceDir: string
): boolean {
  const references = destination.tsconfig?.references as
    | { path?: string }[]
    | undefined;
  if (!references) {
    return false;
  }
  const tsconfigFile = join(destination.dir, "tsconfig.json");
  return references.some(
    (reference) =>
      reference.path !== undefined &&
      resolve(dirname(tsconfigFile), reference.path) === sourceDir
  );
}

function resolveDestination(
  inputs: FoldInputs,
  boundary: Boundary,
  destinationName: string
): { destination: FoldDestination; input?: FoldDestinationInput } {
  const dest = inputs.destinations.get(destinationName);
  if (dest === undefined) {
    throw new Error(`No prepared fold destination for ${destinationName}`);
  }
  if (dest === null) {
    return {
      destination: { package: destinationName, resolution: "unresolved" },
    };
  }
  const shortName = shortNameOf(boundary);
  const destination: FoldDestination = {
    package: destinationName,
    path: dest.relPath,
    resolution: "unresolved",
  };
  if (shortName !== undefined && dest.hasSrc) {
    const exists = dest.srcEntries.get(shortName);
    if (exists === undefined) {
      throw new Error(
        `No prepared src/${shortName} entry for fold destination ${destinationName}`
      );
    }
    destination.directory = `src/${shortName}`;
    destination.resolution = exists ? "resolved" : "suggested";
  }
  return { destination, input: dest };
}

function collectMetadata(
  inputs: FoldInputs,
  boundary: Boundary,
  source: FoldSourceInput,
  names: { destination: string; source: string },
  destination: FoldDestinationInput | undefined
): PackageMetadataImpact[] {
  const impacts: PackageMetadataImpact[] = [];
  const rel = (abs: string) => toPosix(relative(boundary.root, abs));
  const { destination: destinationName, source: sourceName } = names;

  if (source.hasManifest) {
    impacts.push({
      detail: `${sourceName} package manifest defines the boundary being removed.`,
      file: rel(join(boundary.dir, "package.json")),
      kind: "source-manifest",
    });
  }
  if (source.hasTsconfig) {
    impacts.push({
      detail: `${sourceName} TypeScript project configuration would be absorbed or removed.`,
      file: rel(join(boundary.dir, "tsconfig.json")),
      kind: "source-tsconfig",
    });
  }
  if (destination !== undefined) {
    if (declaresDependency(destination.manifest, sourceName)) {
      impacts.push({
        detail: `${destinationName} declares a dependency on ${sourceName}; removable after the fold.`,
        file: rel(join(destination.dir, "package.json")),
        kind: "consumer-dependency",
      });
    }
    if (projectReferencesTo(destination, boundary.dir)) {
      impacts.push({
        detail: `${destinationName} declares a TypeScript project reference to ${sourceName}.`,
        file: rel(join(destination.dir, "tsconfig.json")),
        kind: "project-reference",
      });
    }
  }
  if (answerOf(inputs.workspacePatterns).includes(boundary.relPath)) {
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

export function planFolds(
  boundary: Boundary,
  symbols: SurfaceSymbol[],
  dependencies: SurfaceDependencies,
  opportunities: ReductionOpportunity[],
  config: AnalysisConfig,
  inputs: FoldInputs
): FoldPackagePlan[] {
  const fold = foldOpportunity(opportunities);
  if (fold?.target === undefined) {
    return [];
  }

  const sourceName = boundary.packageName ?? boundary.relPath;
  const destinationName = fold.target.name;
  const [primary] = dependencies.incoming;

  const blockers: PlanBlocker[] = [];
  let status: PlanStatus = "ready";

  const source = sourceInput(inputs, boundary);
  const { destination, input: destinationInput } = resolveDestination(
    inputs,
    boundary,
    destinationName
  );
  if (destinationInput === undefined) {
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

  const files = inventoryFiles(boundary, source);
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
      : collectMetadata(
          inputs,
          boundary,
          source,
          { destination: destinationName, source: sourceName },
          destinationInput
        );

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
