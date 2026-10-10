import type { PackageArchitectureReview } from "./architecture-review-types";
import type { InternalResponsibilityReport } from "./internal-responsibility-types";
import type { InternalRewiringReport } from "./internal-rewiring-types";
import type { InternalPackageTopology } from "./internal-topology-types";
import type { PrimitiveConventionReport } from "./primitive-convention-types";
import type { SymbolLocalityReport } from "./symbol-locality-types";

/** One package's internal structure, every stage through the review. */
export interface PackageInternals {
  locality: SymbolLocalityReport;
  primitives: PrimitiveConventionReport;
  responsibilities: InternalResponsibilityReport;
  review: PackageArchitectureReview;
  rewiring: InternalRewiringReport;
  topology: InternalPackageTopology;
}

/**
 * Saved internals, read back: every stage present and the topology naming
 * the package. Returns the six stages only; throws when any is missing.
 */
export function verifyInternals(
  value: unknown,
  name: string
): PackageInternals {
  const saved: Partial<PackageInternals> =
    typeof value === "object" && value !== null ? value : {};
  const { topology, locality, responsibilities, primitives, rewiring, review } =
    saved;
  if (
    topology?.package?.id !== name ||
    !locality ||
    !responsibilities ||
    !primitives ||
    !rewiring ||
    !review
  ) {
    throw new Error(
      `The dataset's internals for ${name} are incomplete. Run atlas scan again.`
    );
  }
  return { locality, primitives, responsibilities, review, rewiring, topology };
}
