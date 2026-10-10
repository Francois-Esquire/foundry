import { reviewPackageArchitecture } from "./architecture-review";
import { analyzeInternalResponsibilities } from "./internal-responsibility";
import { analyzeInternalRewiring } from "./internal-rewiring";
import { analyzeInternalPackageTopology } from "./internal-topology";
import type { AnalyzePackageLocalOptions } from "./package-local";
import { analyzePackageLocal } from "./package-local";
import type { PackageLocalReport } from "./package-local-types";
import { analyzePrimitiveConventions } from "./primitive-convention";
import { analyzeSymbolLocality } from "./symbol-locality";

export type InternalAnalysisStage =
  | "topology"
  | "locality"
  | "responsibilities"
  | "primitives"
  | "rewiring"
  | "review";

/** One package's internal structure, every stage through the review. */
export type PackageInternals = ReturnType<typeof packageInternals>;

/** Before one package's internals are derived, before the dataset is published. */
export interface InternalsProgressEvent {
  /** The package's position, 1-based, of `total`. */
  index: number;
  kind: "internals";
  package: string;
  total: number;
}

export function runInternalAnalysis(
  options: AnalyzePackageLocalOptions & { through: InternalAnalysisStage }
) {
  const startedAt = performance.now();
  const local = analyzePackageLocal(options);
  const analyzedAt = performance.now();
  const analysis = analyzeInternals(local, options.through);
  return {
    ...analysis,
    timing: { local: analyzedAt - startedAt, ...analysis.timing },
  };
}

/** The internal stages over one package-local report, through `through`, with each stage's time. */
function analyzeInternals(
  local: PackageLocalReport,
  through: InternalAnalysisStage
) {
  const depth = [
    "topology",
    "locality",
    "responsibilities",
    "primitives",
    "rewiring",
    "review",
  ].indexOf(through);
  const startedAt = performance.now();
  const topology = analyzeInternalPackageTopology(local);
  const derivedAt = performance.now();
  const locality =
    depth >= 1 ? analyzeSymbolLocality(local, topology) : undefined;
  const localizedAt = performance.now();
  const responsibilities =
    locality !== undefined && depth >= 2
      ? analyzeInternalResponsibilities(local, topology, locality)
      : undefined;
  const regionedAt = performance.now();
  const primitives =
    locality !== undefined && responsibilities !== undefined && depth >= 3
      ? analyzePrimitiveConventions(local, topology, locality, responsibilities)
      : undefined;
  const classifiedAt = performance.now();
  const rewiring =
    locality !== undefined &&
    responsibilities !== undefined &&
    primitives !== undefined &&
    depth >= 4
      ? analyzeInternalRewiring(
          local,
          topology,
          locality,
          responsibilities,
          primitives
        )
      : undefined;
  const rewiredAt = performance.now();
  const review =
    depth >= 5 && rewiring !== undefined
      ? reviewPackageArchitecture(rewiring)
      : undefined;
  const reviewedAt = performance.now();
  return {
    locality,
    primitives,
    responsibilities,
    review,
    rewiring,
    timing: {
      locality: localizedAt - derivedAt,
      primitives: classifiedAt - regionedAt,
      responsibilities: regionedAt - localizedAt,
      review: reviewedAt - rewiredAt,
      rewiring: rewiredAt - classifiedAt,
      topology: derivedAt - startedAt,
    },
    topology,
  };
}

/** Every internal stage of one package, through the review, without timings. */
export function packageInternals(local: PackageLocalReport) {
  const topology = analyzeInternalPackageTopology(local);
  const locality = analyzeSymbolLocality(local, topology);
  const responsibilities = analyzeInternalResponsibilities(
    local,
    topology,
    locality
  );
  const primitives = analyzePrimitiveConventions(
    local,
    topology,
    locality,
    responsibilities
  );
  const rewiring = analyzeInternalRewiring(
    local,
    topology,
    locality,
    responsibilities,
    primitives
  );
  const review = reviewPackageArchitecture(rewiring);
  return { locality, primitives, responsibilities, review, rewiring, topology };
}

/**
 * Writes each complete package's internals, in id order, announcing each one
 * first. A package is complete when it has a report, and so a local report.
 * An internals crash throws.
 */
export function writeInternals(
  outcomes: readonly {
    local?: PackageLocalReport;
    report?: unknown;
    unit: { id: string };
  }[],
  progress: (event: InternalsProgressEvent) => void,
  write: (id: string, internals: PackageInternals) => void
): void {
  const complete = outcomes
    .flatMap(({ local, report, unit }) =>
      local !== undefined && report !== undefined
        ? [{ id: unit.id, local }]
        : []
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const [index, { id, local }] of complete.entries()) {
    progress({
      index: index + 1,
      kind: "internals",
      package: id,
      total: complete.length,
    });
    write(id, packageInternals(local));
  }
}
