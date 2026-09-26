import { classifyFile } from "./churn";
import { findMiscenteredConcepts } from "./concept-miscentering";
import { analyzeScenarioImpacts } from "./concept-scenario-impact";
import { analyzeArchitecturalReviews } from "./concept-scenario-review";
import { analyzeRecenteringScenarios } from "./concept-scenarios";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  BoundaryInteraction,
  ConceptBehavioralLocality,
  ConceptBehaviorParticipant,
  ConceptDistributionShape,
  ConceptFamily,
  ConceptIdentity,
  ConceptOverlapCandidate,
  ConceptOwnershipAnalysis,
  ConceptOwnershipTension,
  ConceptSeedKind,
  CurrentArchitecturalPlacement,
  RecenteringBehaviorEvidenceKind,
  RecenteringBehaviorProfile,
  RecenteringCandidate,
  RecenteringCandidateReport,
  RecenteringCandidateShape,
  RecenteringCandidateSummary,
  RecenteringCaution,
  RecenteringDimension,
  RecenteringEvidence,
  RecenteringHistoricalContext,
  RecenteringIntentContext,
  RecenteringLocalityContext,
  RecenteringTension,
  RepresentationBoundaryContext,
  SurfaceReport,
} from "./types";

export type RecenteringCandidateSource = Pick<
  SurfaceReport,
  | "conceptInventory"
  | "conceptOverlap"
  | "conceptOwnership"
  | "conceptBehavioralLocality"
  | "boundaryInteractions"
  | "dependencyGravity"
>;

/** A boundary two behavior packages share, with the concept's modules on each side. */
export interface RecenteringBoundaryUse {
  /** Concept modules among the boundary's imported modules. */
  conceptImportedModules: string[];
  /** Import sites naming each concept imported module. */
  conceptImportedSitesByModule: { module: string; importSites: number }[];
  /** Concept modules among the boundary's importing modules. */
  conceptImportingModules: string[];
  /** Import sites each concept importing module contributes to the boundary. */
  conceptImportSitesByModule: { module: string; importSites: number }[];
  /** Modules imported across the boundary. */
  destinationModules: number;
  foreignPackage: string;
  from: string;
  importSites: number;
  sourceModules: number;
  to: string;
}

/** One source module's V8.0 behavior kinds, so a later version can tell what would move with a responsibility. */
export interface RecenteringBehaviorModule {
  conversion: number;
  implementation: number;
  module: string;
  package: string;
  return: number;
  weak: number;
}

export interface RecenteringSourceCoupling {
  coChangeCommits: number;
  left: string;
  leftPackage: string;
  right: string;
  rightPackage: string;
}

/** Everything the gates read; the measurements come from `analyzeRecenteringCandidates`. */
export interface RecenteringFacts {
  alignment: ConceptOwnershipAnalysis["alignment"];
  behavior: RecenteringBehaviorProfile;
  /** V7.4 package edges between source behavior packages; `from` imports `to`. */
  behaviorEdges: { from: string; to: string }[];
  /** V8.3 reads these to simulate what a responsibility move would carry. */
  behaviorModules: RecenteringBehaviorModule[];
  boundaries: RecenteringBoundaryUse[];
  concept: ConceptIdentity;
  /** Incoming boundaries from packages that import the seed module but hold no source behavior, so no V7.4 edge covers them. */
  consumerBoundaries: RecenteringBoundaryUse[];
  contractWithoutImplementations: boolean;
  /** Source behavior package pairs with no static path either way. */
  disconnectedPairs: { left: string; right: string }[];
  distribution: ConceptBehavioralLocality["distribution"];
  distributionShapes: ConceptDistributionShape[];
  halo: ConceptBehavioralLocality["halo"];
  history?: RecenteringHistoricalContext;
  hotspotModules: string[];
  intent: RecenteringIntentContext;
  locality: RecenteringLocalityContext;
  localityCautions: ConceptBehavioralLocality["cautions"];
  ownershipTensions: ConceptOwnershipTension[];
  placement: CurrentArchitecturalPlacement;
  referenceShares: { package: string; share: number }[];
  /** V8.2: every V7.2 overlap partner, graded by the strongest evidence behind the pair. */
  relatedFamilies: RelatedFamily[];
  /** V7.1 representation and reference shares by package. */
  representationShares: { package: string; share: number }[];
  /** V8.1 reads these beside the V8.0 facts above. */
  seed: {
    kind: ConceptSeedKind;
    module: string;
    packagePublic: boolean;
    externallyUsed: boolean;
  };
  /** Import sites into the seed's declaring module, by consuming package. */
  seedImportSites: { package: string; importSites: number }[];
  /** The seed module's share of the target's incoming boundary edges. */
  seedIncomingEdgeShare?: number;
  /** Every strong source-source V6.2 pair between behavior modules, same-package pairs included. */
  sourceCouplings: RecenteringSourceCoupling[];
}

/**
 * Strongest V7.2 relation to a partner: explicit converters, then shape
 * near-equivalence or projection, then property overlap, then name only.
 * Only the first three are strong enough to make the partner's package a
 * supporting-family center.
 */
export type RelatedFamilyRelation =
  | "conversion"
  | "near-equivalent"
  | "projection"
  | "structural"
  | "name";

export interface RelatedFamily {
  bidirectional: boolean;
  concept: ConceptIdentity;
  /** Packages declaring converters between the two, from V7.3. */
  converterPackages: string[];
  relation: RelatedFamilyRelation;
}

const STRONG_KINDS = new Set<RecenteringBehaviorEvidenceKind>([
  "implementation",
  "conversion",
  "return",
]);

const EMPTY_KINDS: Record<RecenteringBehaviorEvidenceKind, number> = {
  construction: 0,
  conversion: 0,
  implementation: 0,
  "parameter-consumer": 0,
  return: 0,
};

function share(part: number, total: number): number | null {
  return total === 0 ? null : part / total;
}

interface Tension {
  dimension: RecenteringDimension;
  kind: RecenteringTension;
  package?: string;
  source: RecenteringEvidence["source"];
  strong: boolean;
  value: number | string | boolean | string[];
}

/** Tensions, dimensions, shapes, status, cautions from measured facts. Counts and shares only. */
export function assessRecentering(
  facts: RecenteringFacts,
  config: AnalysisConfig = ANALYSIS_CONFIG
): RecenteringCandidate | undefined {
  const policy = config.recentering;
  const seed = facts.placement.seedPackage;
  const { behavior, locality } = facts;
  const strongByPackage = new Map(
    behavior.byPackage.map((row) => [row.package, row])
  );
  const strongIn = (pkg: string) => strongByPackage.get(pkg)?.strong ?? 0;
  const returningIn = (pkg: string) =>
    strongByPackage.get(pkg)?.byKind.return ?? 0;
  const contractStrongIn = (
    row: RecenteringBehaviorProfile["byPackage"][number]
  ) => row.byKind.conversion + row.byKind.return;

  const tensions: Tension[] = [];
  for (const tension of facts.ownershipTensions) {
    switch (tension.kind) {
      case "seed-vs-behavior":
        tensions.push({
          dimension: "behavior",
          kind: "semantic-vs-behavior",
          package: tension.observedPackage,
          source: "concept-ownership",
          strong:
            strongIn(tension.observedPackage) >=
            policy.candidates.minStrongBehaviors,
          value: tension.value,
        });
        break;
      case "seed-vs-representation":
        tensions.push({
          dimension: "representation",
          kind: "semantic-vs-representation",
          package: tension.observedPackage,
          source: "concept-ownership",
          strong: true,
          value: tension.value,
        });
        break;
      case "seed-vs-evolution":
        tensions.push({
          dimension: "evolution",
          kind: "semantic-vs-evolution",
          package: tension.observedPackage,
          source: "concept-ownership",
          strong: false,
          value: tension.value,
        });
        break;
      case "anchor-vs-observed-center":
        tensions.push({
          dimension: "intent",
          kind: "anchor-conflict",
          package: tension.observedPackage,
          source: "anchor",
          strong: false,
          value: tension.value,
        });
        break;
      case "usage-vs-semantic-center":
        break;
    }
  }

  const strongPackages = behavior.byPackage.filter((row) => row.strong > 0);
  const distributed = locality.shape === "cross-package-distributed";
  const concentrated =
    behavior.topTwoStrongModuleShare !== null &&
    behavior.topTwoStrongModuleShare >= policy.scatter.maxTopTwoModuleShare;
  const weakShare = share(behavior.weak, behavior.source) ?? 0;
  const broadlyUsed = weakShare > policy.scatter.maxWeakShare;
  // Spread that a boundary or scatter tension can rest on: distributed
  // strong behavior that is neither two modules plus satellites nor
  // mostly parameter consumption.
  const genuinelySpread = distributed && !concentrated && !broadlyUsed;
  if (
    genuinelySpread &&
    behavior.strong >= policy.candidates.minStrongBehaviors &&
    behavior.strongModules >= policy.scatter.minStrongModules &&
    strongPackages.length >= policy.scatter.minStrongPackages
  ) {
    tensions.push({
      dimension: "locality",
      kind: "behavioral-scatter",
      source: "concept-locality",
      strong: true,
      value: strongPackages.map((row) => row.package),
    });
  }

  const implementationCenters = facts.placement.implementationCenters;
  if (implementationCenters.length > 0) {
    const supporting = behavior.byPackage.filter(
      (row) =>
        row.package !== seed &&
        !implementationCenters.includes(row.package) &&
        contractStrongIn(row) > 0
    );
    const total = supporting.reduce(
      (sum, row) => sum + contractStrongIn(row),
      0
    );
    if (total >= policy.implementationScatter.minSupportingBehaviors) {
      tensions.push({
        dimension: "implementation",
        kind: "implementation-scatter",
        source: "concept-ownership",
        strong: false,
        value: supporting.map((row) => row.package),
      });
    }
  }

  const friction = facts.boundaries.filter(
    (boundary) =>
      boundary.importSites >= policy.boundaryFriction.minImportSites &&
      boundary.sourceModules >= policy.boundaryFriction.minSourceModules &&
      boundary.conceptImportingModules.length > 0 &&
      boundary.conceptImportedModules.length > 0 &&
      returningIn(boundary.foreignPackage) >=
        policy.boundaryFriction.minForeignReturnBehaviors
  );
  for (const boundary of friction) {
    tensions.push({
      dimension: "boundary",
      kind: "boundary-friction",
      package: boundary.foreignPackage,
      source: "boundary-interaction",
      strong: genuinelySpread,
      value: boundary.importSites,
    });
  }

  const primary = behavior.primaryStrongPackage;
  if (
    primary !== undefined &&
    primary !== seed &&
    behavior.strong >= policy.candidates.minStrongBehaviors &&
    (behavior.primaryStrongShare ?? 0) >=
      policy.dependencyMisalignment.minStrongShare
  ) {
    const total = facts.seedImportSites.reduce(
      (sum, row) => sum + row.importSites,
      0
    );
    const fromPrimary =
      facts.seedImportSites.find((row) => row.package === primary)
        ?.importSites ?? 0;
    const importShare = share(fromPrimary, total);
    if (
      importShare !== null &&
      importShare >= policy.dependencyMisalignment.minSeedImportSiteShare
    ) {
      tensions.push({
        dimension: "dependency",
        kind: "dependency-misalignment",
        package: primary,
        source: "boundary-interaction",
        strong: false,
        value: importShare,
      });
    }
  }

  const crossCouplings = facts.history?.crossPackageCouplings ?? [];
  if (crossCouplings.length >= policy.temporal.minCrossPackageCouplings) {
    tensions.push({
      dimension: "evolution",
      kind: "temporal-misalignment",
      source: "change-coupling",
      strong: false,
      value: crossCouplings.length,
    });
  }

  if (tensions.length === 0) {
    return undefined;
  }

  // Shapes are the strong structural conditions, each a corroborated
  // combination of tensions; a candidate needs one shape and tensions from
  // several dimensions. History and usage alone never form a shape.
  const has = (kind: RecenteringTension) =>
    tensions.some((item) => item.kind === kind);
  const pointsAt = (kind: RecenteringTension, pkg: string | undefined) =>
    pkg !== undefined &&
    tensions.some((item) => item.kind === kind && item.package === pkg);
  const strongBehaviorAt = tensions.find(
    (item) => item.kind === "semantic-vs-behavior" && item.strong
  )?.package;
  const representationAt = tensions.find(
    (item) => item.kind === "semantic-vs-representation"
  )?.package;
  const shapes: RecenteringCandidateShape[] = [];
  if (
    strongBehaviorAt !== undefined &&
    (pointsAt("semantic-vs-representation", strongBehaviorAt) ||
      pointsAt("semantic-vs-evolution", strongBehaviorAt) ||
      pointsAt("dependency-misalignment", strongBehaviorAt))
  ) {
    shapes.push("mis-centered");
  }
  if (has("behavioral-scatter")) {
    shapes.push("behaviorally-scattered");
  }
  const strongPrimaryAt =
    behavior.strong >= policy.candidates.minStrongBehaviors
      ? behavior.primaryStrongPackage
      : undefined;
  if (
    representationAt !== undefined &&
    (strongPrimaryAt === representationAt ||
      facts.placement.evolutionCenter === representationAt)
  ) {
    shapes.push("representation-drift");
  }
  if (
    has("implementation-scatter") ||
    (implementationCenters.length > 0 &&
      !implementationCenters.includes(seed) &&
      strongBehaviorAt !== undefined &&
      implementationCenters.includes(strongBehaviorAt))
  ) {
    shapes.push("implementation-drift");
  }
  if (
    genuinelySpread &&
    friction.some((boundary) =>
      crossCouplings.some(
        (pair) =>
          (pair.leftPackage === boundary.from &&
            pair.rightPackage === boundary.to) ||
          (pair.leftPackage === boundary.to &&
            pair.rightPackage === boundary.from)
      )
    )
  ) {
    shapes.push("boundary-strained");
  }

  const dimensions = [...new Set(tensions.map((item) => item.dimension))];
  const strongTensions = tensions.filter((item) => item.strong);
  const eligible =
    dimensions.length >= policy.candidates.minEvidenceDimensions &&
    shapes.length > 0;
  const status: RecenteringCandidate["status"] = eligible
    ? facts.intent.seedAnchored
      ? "protected"
      : "candidate"
    : "insufficient-evidence";
  if (status === "protected") {
    shapes.push("intent-protected");
  }

  const cautions: RecenteringCaution[] = [];
  if (behavior.weak > behavior.strong) {
    cautions.push({
      detail: `${behavior.weak} source behaviors accept or construct the concept beside ${behavior.strong} that implement, convert, or return it`,
      kind: "parameter-consumer-dominated",
    });
  }
  if (behavior.strong < policy.candidates.minStrongBehaviors) {
    cautions.push({
      detail: `${behavior.strong} strong source behaviors; below ${policy.candidates.minStrongBehaviors} no behavior tension is strong`,
      kind: "sparse-strong-behavior",
    });
  }
  if (
    distributed &&
    concentrated &&
    behavior.strong >= policy.candidates.minStrongBehaviors
  ) {
    cautions.push({
      detail: `two modules hold ${Math.round((behavior.topTwoStrongModuleShare ?? 0) * 100)}% of strong source behavior; the distributed shape rests on small satellites`,
      kind: "behaviorally-concentrated",
    });
  }
  if (facts.intent.representationBoundaries.length > 0) {
    cautions.push({
      detail: `${facts.intent.representationBoundaries.length} overlap partner(s) with converters in another package; a semantic/persistence split may be intentional`,
      kind: "representation-boundary",
    });
  }
  for (const caution of facts.localityCautions) {
    if (
      caution.kind === "test-heavy-behavior" ||
      caution.kind === "structural-conformance-unobserved" ||
      caution.kind === "target-scoped-history"
    ) {
      cautions.push({ detail: caution.detail, kind: caution.kind });
    }
  }

  const evidence: RecenteringEvidence[] = [
    {
      dimension: "ownership",
      kind: "alignment",
      source: "concept-ownership",
      value: facts.alignment,
    },
  ];
  for (const [kind, pkg] of [
    ["representation-center", facts.placement.representationCenter],
    ["usage-center", facts.placement.usageCenter],
    ["evolution-center", facts.placement.evolutionCenter],
  ] as const) {
    if (pkg !== undefined && pkg !== seed) {
      evidence.push({
        dimension: "ownership",
        kind,
        package: pkg,
        source: "concept-ownership",
        value: pkg,
      });
    }
  }
  if (implementationCenters.length > 0) {
    evidence.push({
      dimension: "implementation",
      kind: "implementation-centers",
      source: "concept-ownership",
      value: implementationCenters,
    });
  }
  for (const tension of tensions) {
    evidence.push({
      dimension: tension.dimension,
      kind: tension.kind,
      ...(tension.package !== undefined && { package: tension.package }),
      source: tension.source,
      value: tension.value,
    });
  }
  evidence.push(
    {
      dimension: "behavior",
      kind: "strong-source-behaviors",
      source: "concept-ownership",
      value: behavior.strong,
    },
    {
      dimension: "behavior",
      kind: "weak-source-behaviors",
      source: "concept-ownership",
      value: behavior.weak,
    }
  );
  if (primary !== undefined) {
    evidence.push({
      dimension: "behavior",
      kind: "primary-strong-package-share",
      package: primary,
      source: "concept-ownership",
      value: behavior.primaryStrongShare ?? 0,
    });
  }
  evidence.push(
    {
      dimension: "locality",
      kind: "shape",
      source: "concept-locality",
      value: locality.shape,
    },
    {
      dimension: "locality",
      kind: "source-modules",
      source: "concept-locality",
      value: locality.sourceModules,
    },
    {
      dimension: "locality",
      kind: "source-packages",
      source: "concept-locality",
      value: locality.sourcePackages,
    }
  );
  if (locality.topTwoModuleShare !== null) {
    evidence.push({
      dimension: "locality",
      kind: "top-two-module-share",
      source: "concept-locality",
      value: locality.topTwoModuleShare,
    });
  }
  if (locality.disconnectedPackagePairs + locality.disconnectedModules > 0) {
    evidence.push({
      dimension: "locality",
      kind: "disconnected",
      source: "concept-locality",
      value: locality.disconnectedPackagePairs + locality.disconnectedModules,
    });
  }
  if (facts.distribution.representation.package !== undefined) {
    evidence.push({
      dimension: "representation",
      kind: "primary-representation-share",
      package: facts.distribution.representation.package,
      source: "concept-distribution",
      value: facts.distribution.representation.share ?? 0,
    });
  }
  evidence.push({
    dimension: "ownership",
    kind: "reference-halo-modules",
    source: "concept-distribution",
    value: facts.halo.modules,
  });
  for (const boundary of friction) {
    evidence.push({
      dimension: "boundary",
      kind: "boundary-concept-modules",
      package: boundary.foreignPackage,
      source: "boundary-interaction",
      value: [
        ...boundary.conceptImportingModules,
        ...boundary.conceptImportedModules,
      ],
    });
  }
  if (facts.seedIncomingEdgeShare !== undefined) {
    evidence.push({
      dimension: "dependency",
      kind: "seed-module-incoming-edge-share",
      source: "gravity",
      value: facts.seedIncomingEdgeShare,
    });
  }
  if (facts.history !== undefined) {
    evidence.push({
      dimension: "evolution",
      kind: "hotspot-behavior-modules",
      source: "hotspots",
      value: facts.history.hotspotModules,
    });
    if (facts.history.crossPackageCouplings.length > 0) {
      evidence.push({
        dimension: "evolution",
        kind: "cross-package-behavior-couplings",
        source: "change-coupling",
        value: facts.history.crossPackageCouplings.map(
          (pair) => `${pair.left} ↔ ${pair.right}`
        ),
      });
    }
  }
  if (facts.intent.seedAnchored) {
    evidence.push({
      dimension: "intent",
      kind: "seed-package-anchored",
      package: seed,
      source: "anchor",
      value: facts.intent.anchorReason ?? true,
    });
  }
  for (const pkg of facts.intent.anchoredObservedPackages) {
    evidence.push({
      dimension: "intent",
      kind: "observed-package-anchored",
      package: pkg,
      source: "anchor",
      value: true,
    });
  }
  for (const context of facts.intent.representationBoundaries) {
    evidence.push({
      dimension: "representation",
      kind: "representation-boundary",
      source: "concept-overlap",
      value: context.converterPackages,
    });
  }

  return {
    behavior,
    currentPlacement: facts.placement,
    dimensions,
    evidence,
    id: facts.concept.id,
    locality,
    shapes,
    strongTensions: strongTensions.map((item) => item.kind),
    subject: { concept: facts.concept, kind: "concept-family" },
    tensions: tensions.map((item) => item.kind),
    ...(facts.history !== undefined && { history: facts.history }),
    cautions,
    intent: facts.intent,
    status,
  };
}

export interface ClassifiedParticipant {
  kind: RecenteringBehaviorEvidenceKind;
  participant: ConceptBehaviorParticipant;
}

const KEY = "\n";

/**
 * Behavior evidence kind per participant, read from the family's evidence
 * inside the participant's own line range. V7.3 attribution is untouched;
 * this only says what each attributed symbol does with the concept.
 */
export function classifyParticipants(
  family: ConceptFamily,
  participants: ConceptBehaviorParticipant[],
  conversions: { file: string; function: string }[]
): ClassifiedParticipant[] {
  const converters = new Set(
    conversions.map((item) => `${item.file}${KEY}${item.function}`)
  );
  const index = new Map<string, { kind: string; line: number }[]>();
  for (const item of family.evidence) {
    if (item.source === undefined) {
      continue;
    }
    const key = `${item.file}${KEY}${item.source.name}`;
    const list = index.get(key);
    if (list === undefined) {
      index.set(key, [{ kind: item.kind, line: item.line }]);
    } else {
      list.push({ kind: item.kind, line: item.line });
    }
  }
  return participants.map((participant) => {
    if (participant.role === "implementation") {
      return { kind: "implementation", participant };
    }
    if (converters.has(`${participant.file}${KEY}${participant.symbol}`)) {
      return { kind: "conversion", participant };
    }
    const base = participant.symbol.split(".")[0] ?? participant.symbol;
    const lines = participant.lines;
    const kinds = new Set(
      (index.get(`${participant.file}${KEY}${base}`) ?? [])
        .filter(
          (entry) =>
            lines === undefined ||
            (lines.start <= entry.line && entry.line <= lines.end)
        )
        .map((entry) => entry.kind)
    );
    if (kinds.has("return-type")) {
      return { kind: "return", participant };
    }
    if (kinds.has("constructs")) {
      return { kind: "construction", participant };
    }
    return { kind: "parameter-consumer", participant };
  });
}

function profileOf(
  classified: ClassifiedParticipant[]
): RecenteringBehaviorProfile {
  const byKind = { ...EMPTY_KINDS };
  const packages = new Map<
    string,
    RecenteringBehaviorProfile["byPackage"][number]
  >();
  const strongByModule = new Map<string, number>();
  let source = 0;
  for (const { participant, kind } of classified) {
    if (participant.kind !== "source") {
      continue;
    }
    source += 1;
    byKind[kind] += 1;
    let row = packages.get(participant.package);
    if (row === undefined) {
      row = {
        byKind: { ...EMPTY_KINDS },
        package: participant.package,
        strong: 0,
        weak: 0,
      };
      packages.set(participant.package, row);
    }
    row.byKind[kind] += 1;
    if (STRONG_KINDS.has(kind)) {
      row.strong += 1;
      strongByModule.set(
        participant.file,
        (strongByModule.get(participant.file) ?? 0) + 1
      );
    } else {
      row.weak += 1;
    }
  }
  const byPackage = [...packages.values()].sort(
    (a, b) => b.strong - a.strong || a.package.localeCompare(b.package)
  );
  const strong = byPackage.reduce((sum, row) => sum + row.strong, 0);
  const topTwo = [...strongByModule.values()]
    .sort((a, b) => b - a)
    .slice(0, 2)
    .reduce((sum, count) => sum + count, 0);
  const top = byPackage[0];
  return {
    byKind,
    byPackage,
    source,
    strong,
    strongModules: strongByModule.size,
    topTwoStrongModuleShare: share(topTwo, strong),
    weak: source - strong,
    ...(top !== undefined &&
      top.strong > 0 && { primaryStrongPackage: top.package }),
    primaryStrongShare: top === undefined ? null : share(top.strong, strong),
  };
}

function modulesOf(
  classified: ClassifiedParticipant[]
): RecenteringBehaviorModule[] {
  const rows = new Map<string, RecenteringBehaviorModule>();
  for (const { participant, kind } of classified) {
    if (participant.kind !== "source") {
      continue;
    }
    let row = rows.get(participant.file);
    if (row === undefined) {
      row = {
        conversion: 0,
        implementation: 0,
        module: participant.file,
        package: participant.package,
        return: 0,
        weak: 0,
      };
      rows.set(participant.file, row);
    }
    if (
      kind === "implementation" ||
      kind === "conversion" ||
      kind === "return"
    ) {
      row[kind] += 1;
    } else {
      row.weak += 1;
    }
  }
  return [...rows.values()].sort((a, b) => a.module.localeCompare(b.module));
}

function relationOf(candidate: ConceptOverlapCandidate): RelatedFamilyRelation {
  if (candidate.conversions.length > 0) {
    return "conversion";
  }
  if (candidate.shapes.includes("near-equivalent")) {
    return "near-equivalent";
  }
  if (candidate.shapes.includes("projection-like")) {
    return "projection";
  }
  if (candidate.shapes.includes("structurally-overlapping")) {
    return "structural";
  }
  return "name";
}

function moduleNames(rows: BoundaryInteraction["sourceModules"]): Set<string> {
  return new Set(rows.map((row) => row.module));
}

function intersect(modules: Iterable<string>, within: Set<string>): string[] {
  return [...modules].filter((module) => within.has(module)).sort();
}

/**
 * Re-centering candidates among V7.0 families. Purely compositional over
 * V7.1–V7.4, boundary interactions, gravity, and the configured anchors:
 * no scan, no history parse, no destination.
 */
export function analyzeRecenteringCandidates(
  source: RecenteringCandidateSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): RecenteringCandidateReport {
  const target = source.conceptOwnership.target;
  const ownershipBySeed = new Map(
    source.conceptOwnership.concepts.map((item) => [item.concept.id, item])
  );
  const localityBySeed = new Map(
    source.conceptBehavioralLocality.concepts.map((item) => [
      item.concept.id,
      item,
    ])
  );
  const overlapBySeed = new Map<string, ConceptOverlapCandidate[]>();
  for (const candidate of source.conceptOverlap.candidates) {
    for (const side of [candidate.left, candidate.right]) {
      if (!side.inTarget) {
        continue;
      }
      const list = overlapBySeed.get(side.id) ?? [];
      list.push(candidate);
      overlapBySeed.set(side.id, list);
    }
  }
  const anchored = new Set(config.anchors.map((anchor) => anchor.target));
  const incomingByPackage = new Map(
    source.boundaryInteractions.incoming.map((item) => [item.from, item])
  );
  const outgoingByPackage = new Map(
    source.boundaryInteractions.outgoing.map((item) => [item.to, item])
  );
  const incomingEdgeShare = new Map(
    source.dependencyGravity.incomingConcentration.map((row) => [
      row.module,
      row.share,
    ])
  );

  const emitted: RecenteringCandidate[] = [];
  const collected: RecenteringFacts[] = [];
  for (const family of source.conceptInventory.families) {
    const ownership = ownershipBySeed.get(family.seed.id);
    const locality = localityBySeed.get(family.seed.id);
    if (ownership === undefined || locality === undefined) {
      throw new Error(
        `concept ownership and locality are not attached for ${family.seed.name}`
      );
    }
    const seed = family.seed.declaration.package;
    const seedFile = family.seed.declaration.file;
    const packageOfModule = new Map(
      locality.behavior.byModule.map((row) => [row.module, row.package])
    );

    const overlaps = overlapBySeed.get(family.seed.id) ?? [];
    const conversions = overlaps.flatMap((candidate) => candidate.conversions);
    const participants = [...ownership.behavior.participants];
    for (const conversion of conversions) {
      const attributed = participants.some(
        (item) =>
          item.file === conversion.file && item.symbol === conversion.function
      );
      if (attributed) {
        continue;
      }
      participants.push({
        file: conversion.file,
        kind: classifyFile(conversion.file),
        member: "function",
        package: packageOfModule.get(conversion.file) ?? "<root>",
        role: "contract",
        symbol: conversion.function,
      });
    }
    const classified = classifyParticipants(family, participants, conversions);
    const behavior = profileOf(classified);

    const sourceRows = locality.behavior.byModule.filter(
      (row) => row.kind === "source"
    );
    const topTwo = [...sourceRows]
      .sort((a, b) => b.behaviors - a.behaviors)
      .slice(0, 2)
      .reduce((sum, row) => sum + row.behaviors, 0);
    const localityContext: RecenteringLocalityContext = {
      disconnectedModules: locality.traversal.disconnectedModules,
      disconnectedPackagePairs: locality.traversal.disconnectedPackagePairs,
      maxModuleDistance: locality.traversal.maxModuleDistance,
      modifiers: locality.shape.modifiers,
      primaryPackageShare: locality.concentration.primaryPackageShare,
      shape: locality.shape.primary,
      sourceBehaviors: locality.behavior.source,
      sourceModules: locality.span.sourceModuleCount,
      sourcePackages: locality.span.sourcePackageCount,
      topTwoModuleShare: share(topTwo, locality.behavior.source),
    };

    const targetConceptModules = new Set([
      seedFile,
      ...family.representations
        .filter((item) => item.package === target)
        .map((item) => item.file),
      ...sourceRows
        .filter((row) => row.package === target)
        .map((row) => row.module),
    ]);
    const foreignConceptModules = (pkg: string) =>
      new Set([
        ...family.representations
          .filter((item) => item.package === pkg)
          .map((item) => item.file),
        ...sourceRows
          .filter((row) => row.package === pkg)
          .map((row) => row.module),
      ]);
    const boundaries: RecenteringBoundaryUse[] = [];
    const boundaryUse = (
      edge: { from: string; to: string },
      interaction: BoundaryInteraction,
      importing: Set<string>,
      imported: Set<string>
    ): RecenteringBoundaryUse => {
      const conceptImportingModules = intersect(
        importing,
        moduleNames(interaction.sourceModules)
      );
      const conceptImportedModules = intersect(
        imported,
        moduleNames(interaction.destinationModules)
      );
      const sitesOf = (
        rows: BoundaryInteraction["sourceModules"],
        modules: string[]
      ) =>
        rows
          .filter((row) => modules.includes(row.module))
          .map((row) => ({ importSites: row.importSites, module: row.module }))
          .sort((a, b) => a.module.localeCompare(b.module));
      return {
        conceptImportedModules,
        conceptImportedSitesByModule: sitesOf(
          interaction.destinationModules,
          conceptImportedModules
        ),
        conceptImportingModules,
        conceptImportSitesByModule: sitesOf(
          interaction.sourceModules,
          conceptImportingModules
        ),
        destinationModules: interaction.breadth.destinationModules,
        foreignPackage: edge.from === target ? edge.to : edge.from,
        from: edge.from,
        importSites: interaction.importSites,
        sourceModules: interaction.breadth.sourceModules,
        to: edge.to,
      };
    };
    for (const edge of locality.span.boundaryEdges) {
      if (edge.to === target) {
        const interaction = incomingByPackage.get(edge.from);
        if (interaction === undefined) {
          continue;
        }
        boundaries.push(
          boundaryUse(
            edge,
            interaction,
            foreignConceptModules(edge.from),
            targetConceptModules
          )
        );
      } else if (edge.from === target) {
        const interaction = outgoingByPackage.get(edge.to);
        if (interaction === undefined) {
          continue;
        }
        boundaries.push(
          boundaryUse(
            edge,
            interaction,
            targetConceptModules,
            foreignConceptModules(edge.to)
          )
        );
      }
    }

    const seedImportSites = source.boundaryInteractions.incoming
      .map((interaction) => ({
        importSites:
          interaction.destinationModules.find((row) => row.module === seedFile)
            ?.importSites ?? 0,
        package: interaction.from,
      }))
      .filter((row) => row.importSites > 0);
    const covered = new Set(boundaries.map((boundary) => boundary.from));
    const consumerBoundaries = seedImportSites.flatMap((row) => {
      const interaction = incomingByPackage.get(row.package);
      return interaction === undefined || covered.has(row.package)
        ? []
        : [
            boundaryUse(
              { from: row.package, to: target },
              interaction,
              foreignConceptModules(row.package),
              targetConceptModules
            ),
          ];
    });
    const seedIncomingEdgeShare = incomingEdgeShare.get(seedFile);

    let history: RecenteringHistoricalContext | undefined;
    const sourceCouplings: RecenteringSourceCoupling[] = (
      locality.temporal?.internalCouplings ?? []
    )
      .filter((pair) => pair.context === "source-source")
      .map((pair) => ({
        coChangeCommits: pair.coChangeCommits,
        left: pair.left,
        leftPackage: packageOfModule.get(pair.left) ?? "<root>",
        right: pair.right,
        rightPackage: packageOfModule.get(pair.right) ?? "<root>",
      }));
    if (locality.temporal !== undefined) {
      history = {
        crossPackageCouplings: sourceCouplings.filter(
          (pair) => pair.leftPackage !== pair.rightPackage
        ),
        hotspotModules: locality.changeSurface.hotspotModules,
        internalSourceCouplings: sourceCouplings.length,
        ...(ownership.center.evolution !== undefined && {
          evolutionCenter: ownership.center.evolution,
        }),
      };
    }

    const placement: CurrentArchitecturalPlacement = {
      seedPackage: seed,
      ...(ownership.center.semantic !== undefined && {
        semanticCenter: ownership.center.semantic,
      }),
      ...(ownership.center.representation !== undefined && {
        representationCenter: ownership.center.representation,
      }),
      ...(ownership.center.usage !== undefined && {
        usageCenter: ownership.center.usage,
      }),
      ...(ownership.center.evolution !== undefined && {
        evolutionCenter: ownership.center.evolution,
      }),
      behaviorPackages: locality.traversal.participatingPackages,
      implementationCenters: ownership.center.implementations,
    };
    const observed = new Set([
      ...ownership.center.implementations,
      ...[
        ownership.center.representation,
        ownership.center.usage,
        ownership.center.behavior,
        ownership.center.evolution,
      ].filter((pkg): pkg is string => pkg !== undefined),
      ...placement.behaviorPackages,
    ]);
    observed.delete(seed);
    const anchorReason = config.anchors.find(
      (anchor) => anchor.target === seed
    )?.reason;
    const representationBoundaries: RepresentationBoundaryContext[] =
      ownership.overlap
        .filter((context) => context.representationBoundary)
        .map((context) => {
          const candidate = overlaps.find(
            (item) =>
              item.left.id === context.other.id ||
              item.right.id === context.other.id
          );
          return {
            converterPackages: context.conversionPackages,
            explicitBidirectionalConversion:
              candidate?.bidirectionalConversion ?? false,
            overlappingConcept: context.other,
            ...(candidate?.structure !== undefined && {
              structuralOverlap: candidate.structure.jaccard,
            }),
          };
        });
    const intent: RecenteringIntentContext = {
      seedAnchored: anchored.has(seed),
      ...(anchorReason !== undefined && { anchorReason }),
      anchoredObservedPackages: [...observed]
        .filter((pkg) => anchored.has(pkg))
        .sort(),
      representationBoundaries,
    };

    const distribution = family.distributionAnalysis;
    if (distribution === undefined) {
      throw new Error(
        `concept distribution is not attached for ${family.seed.name}`
      );
    }
    const facts: RecenteringFacts = {
      alignment: ownership.alignment,
      behavior,
      boundaries,
      concept: ownership.concept,
      contractWithoutImplementations: ownership.cautions.some(
        (caution) => caution.kind === "no-implementation-evidence"
      ),
      distribution: locality.distribution,
      halo: locality.halo,
      locality: localityContext,
      localityCautions: locality.cautions,
      ownershipTensions: ownership.tensions,
      placement,
      seedImportSites,
      ...(seedIncomingEdgeShare !== undefined && { seedIncomingEdgeShare }),
      ...(history !== undefined && { history }),
      behaviorEdges: locality.span.boundaryEdges,
      behaviorModules: modulesOf(classified),
      consumerBoundaries,
      disconnectedPairs: locality.traversal.packageDistances
        .filter(
          (pair) => pair.outward === undefined && pair.inward === undefined
        )
        .map((pair) => ({ left: pair.from, right: pair.to })),
      distributionShapes: distribution.shapes,
      hotspotModules: (locality.temporal?.hotspots ?? []).map(
        (row) => row.module
      ),
      intent,
      referenceShares: distribution.references.byPackage.map((row) => ({
        package: row.package,
        share: row.share,
      })),
      relatedFamilies: overlaps.map((candidate) => {
        const other =
          candidate.left.id === family.seed.id
            ? candidate.right
            : candidate.left;
        return {
          bidirectional: candidate.bidirectionalConversion,
          concept: other,
          converterPackages:
            ownership.overlap.find((context) => context.other.id === other.id)
              ?.conversionPackages ?? [],
          relation: relationOf(candidate),
        };
      }),
      representationShares: distribution.representations.packages.map(
        (row) => ({
          package: row.package,
          share:
            share(row.representations, distribution.representations.total) ?? 0,
        })
      ),
      seed: {
        externallyUsed: family.seed.surface.externallyUsed,
        kind: family.seed.kind,
        module: seedFile,
        packagePublic: family.seed.surface.packagePublic,
      },
      sourceCouplings,
    };
    collected.push(facts);
    const candidate = assessRecentering(facts, config);
    if (candidate !== undefined) {
      emitted.push(candidate);
    }
  }

  const support = (item: RecenteringCandidate) =>
    (item.history?.hotspotModules ?? 0) +
    (item.history?.crossPackageCouplings.length ?? 0);
  emitted.sort(
    (a, b) =>
      b.strongTensions.length - a.strongTensions.length ||
      b.dimensions.length - a.dimensions.length ||
      b.behavior.strong - a.behavior.strong ||
      support(b) - support(a) ||
      a.subject.concept.name.localeCompare(b.subject.concept.name)
  );

  const byShape: RecenteringCandidateSummary["byShape"] = {
    "behaviorally-scattered": 0,
    "boundary-strained": 0,
    "implementation-drift": 0,
    "intent-protected": 0,
    "mis-centered": 0,
    "representation-drift": 0,
  };
  const byTension: RecenteringCandidateSummary["byTension"] = {
    "anchor-conflict": 0,
    "behavioral-scatter": 0,
    "boundary-friction": 0,
    "dependency-misalignment": 0,
    "implementation-scatter": 0,
    "semantic-vs-behavior": 0,
    "semantic-vs-evolution": 0,
    "semantic-vs-representation": 0,
    "temporal-misalignment": 0,
  };
  for (const item of emitted) {
    for (const shape of item.shapes) {
      byShape[shape] += 1;
    }
    for (const tension of new Set(item.tensions)) {
      byTension[tension] += 1;
    }
  }
  const count = (status: RecenteringCandidate["status"]) =>
    emitted.filter((item) => item.status === status).length;
  const miscentered = findMiscenteredConcepts(target, collected, config);
  const scenarios = analyzeRecenteringScenarios(
    target,
    miscentered,
    collected,
    config
  );
  const impacts = analyzeScenarioImpacts(
    { facts: collected, miscentered, scenarios },
    config
  );
  return {
    candidates: emitted,
    impacts,
    miscentered,
    reviews: analyzeArchitecturalReviews({ impacts, scenarios }, config),
    scenarios,
    summary: {
      byShape,
      byTension,
      candidates: count("candidate"),
      evaluated: source.conceptInventory.families.length,
      insufficientEvidence: count("insufficient-evidence"),
      protected: count("protected"),
    },
    target,
  };
}
