import type { PackageArchitectureReview } from "../lib/architecture-review-types";
import type {
  InternalRewiringReport,
  InternalRewiringScenario,
} from "../lib/internal-rewiring-types";
import type {
  ArchitecturalRoleFinding,
  PrimitiveConventionReport,
} from "../lib/primitive-convention-types";

export interface AtlasArchitecture {
  primitives: PrimitiveConventionReport;
  review: PackageArchitectureReview;
  rewiring: InternalRewiringReport;
}

export function familyScenario(
  architecture: AtlasArchitecture,
  familyId: string,
  scenarioId: string
) {
  return architecture.rewiring.scenarios.find(
    (scenario) =>
      scenario.id === scenarioId && scenario.subject.key === familyId
  );
}

export function scenarioReview(
  architecture: AtlasArchitecture,
  scenario: InternalRewiringScenario
) {
  return architecture.review.scenarios.find(
    (review) =>
      review.scenarioId === scenario.id &&
      review.familyId === scenario.subject.key
  );
}

export function compositionGroups(
  symbols: readonly ArchitecturalRoleFinding[],
  module: string
) {
  const groups = new Map<string, ArchitecturalRoleFinding[]>();
  for (const symbol of symbols) {
    if (symbol.declaration.module !== module) {
      continue;
    }
    const key = symbol.served?.responsibility ?? symbol.scope;
    const members = groups.get(key) ?? [];
    members.push(symbol);
    groups.set(key, members);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, members]) => ({
      id,
      symbols: members.sort((a, b) => a.symbolId.localeCompare(b.symbolId)),
    }));
}
