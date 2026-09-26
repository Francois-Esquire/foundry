import { reviewPackageArchitecture } from "./architecture-review";
import { analyzeInternalResponsibilities } from "./internal-responsibility";
import { analyzeInternalRewiring } from "./internal-rewiring";
import { analyzeInternalPackageTopology } from "./internal-topology";
import type { AnalyzePackageLocalOptions } from "./package-local";
import { analyzePackageLocal } from "./package-local";
import { analyzePrimitiveConventions } from "./primitive-convention";
import { analyzeSymbolLocality } from "./symbol-locality";

export type InternalAnalysisStage =
  | "topology"
  | "locality"
  | "responsibilities"
  | "primitives"
  | "rewiring"
  | "review";

export function runInternalAnalysis(
  options: AnalyzePackageLocalOptions & { through: InternalAnalysisStage }
) {
  const depth = [
    "topology",
    "locality",
    "responsibilities",
    "primitives",
    "rewiring",
    "review",
  ].indexOf(options.through);
  const startedAt = performance.now();
  const local = analyzePackageLocal(options);
  const analyzedAt = performance.now();
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
      local: analyzedAt - startedAt,
      locality: localizedAt - derivedAt,
      primitives: classifiedAt - regionedAt,
      responsibilities: regionedAt - localizedAt,
      review: reviewedAt - rewiredAt,
      rewiring: rewiredAt - classifiedAt,
      topology: derivedAt - analyzedAt,
    },
    topology,
  };
}
