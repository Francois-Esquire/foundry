import type {
  RecenteringBoundaryUse,
  RecenteringFacts,
} from "./concept-recentering";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  ConceptSeedKind,
  MiscenteredConceptFinding,
  MiscenteredConceptReport,
  MiscenteredConceptSummary,
  MiscenteringCaution,
  MiscenteringEvidence,
  MiscenteringEvidenceKind,
  MiscenteringGravityFamily,
  MiscenteringOutcome,
  MiscenteringSignal,
  ObservedCenter,
} from "./types";

/** Seeds whose `implements` participants are adapters, not governing behavior. */
const CONTRACT_KINDS = new Set<ConceptSeedKind>(["interface", "type"]);

const GRAVITY_FAMILIES: MiscenteringGravityFamily[] = [
  "behavioral-locality",
  "symbol-distribution",
  "consumer-gravity",
];

/** Evidence rows kept per family, strongest first. */
const ROWS_PER_FAMILY = 5;

export interface GoverningBehavior {
  /** `implements` of an interface or type seed: adapters, not governing behavior. */
  adapters: number;
  construction: number;
  conversions: number;
  /** Conversion, return, and (class seeds only) implementation behavior. */
  count: number;
  package: string;
}

/** Per-package governing behavior under the V8.1 adapter rule; packages with neither governing nor adapter behavior are omitted. */
export function governingBehavior(
  facts: RecenteringFacts
): GoverningBehavior[] {
  const contract = CONTRACT_KINDS.has(facts.seed.kind);
  return facts.behavior.byPackage
    .map((row) => ({
      adapters: contract ? row.byKind.implementation : 0,
      construction: row.byKind.construction,
      conversions: row.byKind.conversion,
      count:
        row.byKind.conversion +
        row.byKind.return +
        (contract ? 0 : row.byKind.implementation),
      package: row.package,
    }))
    .filter((row) => row.count > 0 || row.adapters > 0);
}

export interface MiscenteringAssessment {
  finding?: MiscenteredConceptFinding;
  outcome: MiscenteringOutcome;
}

interface PackageShare {
  package: string;
  share: number;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function pointsAt(
  rows: PackageShare[],
  pkg: string,
  minShare: number
): boolean {
  return rows.some((row) => row.package === pkg && row.share >= minShare);
}

/** No package reaches `maxShare` and at least `minPackages` reach `minShare`. */
function divided(
  rows: PackageShare[],
  maxShare: number,
  minShare: number,
  minPackages: number
): boolean {
  return (
    rows.length > 0 &&
    rows.every((row) => row.share < maxShare) &&
    rows.filter((row) => row.share >= minShare).length >= minPackages
  );
}

/**
 * Declared home against observed center of gravity for one concept. The
 * declared home is the seed declaration; gravity composes the V8.0
 * governing-behavior share, the V7.1 representation share, and the V7.1
 * reference share. A finding needs two independent families and, for
 * external gravity and drift, behavior among them: using a concept is
 * never enough on its own.
 */
export function assessMiscentering(
  facts: RecenteringFacts,
  config: AnalysisConfig = ANALYSIS_CONFIG
): MiscenteringAssessment {
  const policy = config.recentering.miscentering;
  const home = facts.placement.seedPackage;
  const anchored = new Set(config.anchors.map((anchor) => anchor.target));
  const contract = CONTRACT_KINDS.has(facts.seed.kind);

  const governing = governingBehavior(facts);
  const governingTotal = governing.reduce((sum, row) => sum + row.count, 0);
  const foreignAdapters = governing
    .filter((row) => row.package !== home)
    .reduce((sum, row) => sum + row.adapters, 0);
  const behaviorShares: PackageShare[] = governing
    .filter((row) => row.count > 0)
    .map((row) => ({
      package: row.package,
      share: row.count / governingTotal,
    }));
  const importTotal = facts.seedImportSites.reduce(
    (sum, row) => sum + row.importSites,
    0
  );
  const dependencyShares: PackageShare[] = facts.seedImportSites.map((row) => ({
    package: row.package,
    share: row.importSites / importTotal,
  }));
  const shares: Record<MiscenteringGravityFamily, PackageShare[]> = {
    "behavioral-locality": behaviorShares,
    "consumer-gravity": facts.referenceShares,
    "symbol-distribution": facts.representationShares,
  };

  const gravityFamilies = GRAVITY_FAMILIES.filter(
    (family) => shares[family].length > 0
  );
  const weightTotal = gravityFamilies.reduce(
    (sum, family) => sum + policy.gravity.weights[family],
    0
  );
  const weights: Partial<Record<MiscenteringGravityFamily, number>> = {};
  for (const family of gravityFamilies) {
    weights[family] = policy.gravity.weights[family] / weightTotal;
  }
  const packages = new Set<string>([home]);
  assessMiscenteringFamily(gravityFamilies, shares, packages);
  const centers: ObservedCenter[] = [...packages]
    .map((pkg) => {
      const perFamily: ObservedCenter["shares"] = {};
      let gravity = 0;
      for (const family of gravityFamilies) {
        const value =
          shares[family].find((row) => row.package === pkg)?.share ?? 0;
        perFamily[family] = value;
        gravity += (weights[family] ?? 0) * value;
      }
      return {
        anchored: anchored.has(pkg),
        gravity,
        shares: perFamily,
        target: pkg,
      };
    })
    .sort((a, b) => b.gravity - a.gravity || a.target.localeCompare(b.target));
  const gravityOf = (pkg: string) =>
    centers.find((center) => center.target === pkg)?.gravity ?? 0;
  const homeGravity = gravityOf(home);
  const top = centers.find((center) => center.target !== home);

  const cautions: MiscenteringCaution[] = [];
  if (foreignAdapters > 0) {
    cautions.push({
      detail: `${foreignAdapters} implementation(s) of the ${facts.seed.kind} outside ${home} read as adapters and do not count as governing behavior`,
      kind: "adapter-implementations",
    });
  }

  if (governingTotal < config.recentering.candidates.minStrongBehaviors) {
    return { outcome: "behavior-light" };
  }
  if (top === undefined) {
    return { outcome: "aligned" };
  }

  const minShare = policy.minFamilyShare;
  const { evolutionCenter } = facts.placement;
  const crossings = facts.boundaries.filter(
    (boundary) =>
      boundary.conceptImportingModules.length > 0 &&
      boundary.conceptImportedModules.length > 0
  );
  const supportersOf = (pkg: string): MiscenteringEvidenceKind[] => {
    const found: MiscenteringEvidenceKind[] = [];
    if (pointsAt(behaviorShares, pkg, minShare)) {
      found.push("behavioral-locality");
    }
    if (pointsAt(facts.representationShares, pkg, minShare)) {
      found.push("symbol-distribution");
    }
    if (pointsAt(facts.referenceShares, pkg, minShare)) {
      found.push("consumer-gravity");
    }
    if (pointsAt(dependencyShares, pkg, minShare)) {
      found.push("dependency-gravity");
    }
    if (crossings.some((boundary) => boundary.foreignPackage === pkg)) {
      found.push("boundary-crossing");
    }
    if (evolutionCenter === pkg) {
      found.push("ownership");
    }
    return found;
  };

  let signal: MiscenteringSignal | undefined;
  let supporting: MiscenteringEvidenceKind[] = [];
  let magnitude = 0;
  const mismatch = top.gravity - homeGravity;
  const homeBehaviorShare =
    behaviorShares.find((row) => row.package === home)?.share ?? 0;
  const foreignBehaviorShare = 1 - homeBehaviorShare;
  const foreignBehaviors = governing
    .filter((row) => row.package !== home)
    .reduce((sum, row) => sum + row.count, 0);

  const topSupporters = supportersOf(top.target);
  ({ signal, supporting, magnitude } = assessMiscenteringEntries(
    top,
    policy,
    mismatch,
    topSupporters,
    signal,
    supporting,
    magnitude,
    facts,
    home,
    minShare,
    foreignBehaviorShare,
    foreignBehaviors,
    crossings,
    evolutionCenter
  ));
  // A broadly consumed type (identifiers, shared contracts) divides its few
  // producers across its consumers; that is breadth of use, not split
  // ownership, so consumption-heavy concepts never read as split.
  const consumptionHeavy = facts.behavior.weak > facts.behavior.strong;
  ({ signal, supporting, magnitude } = assessMiscenteringEntries2(
    signal,
    consumptionHeavy,
    centers,
    policy,
    behaviorShares,
    minShare,
    facts,
    supporting,
    magnitude
  ));
  if (signal === undefined) {
    if (homeBehaviorShare < minShare) {
      return { outcome: "unclear" };
    }
    const consumptionLed = centers.some(
      (center) =>
        center.target !== home &&
        (pointsAt(facts.referenceShares, center.target, minShare) ||
          pointsAt(dependencyShares, center.target, minShare))
    );
    return { outcome: consumptionLed ? "usage-only" : "aligned" };
  }

  const familiesWithData: MiscenteringEvidenceKind[] = [
    ...gravityFamilies,
    ...(dependencyShares.length > 0 ? (["dependency-gravity"] as const) : []),
    ...(facts.boundaries.length > 0 ? (["boundary-crossing"] as const) : []),
    ...(evolutionCenter === undefined ? [] : (["ownership"] as const)),
    "concept-distribution",
  ];
  const evidenceConfidence =
    (supporting.length / familiesWithData.length) * (0.5 + 0.5 * magnitude);

  const supports = (family: MiscenteringEvidenceKind, pkg?: string) =>
    supporting.includes(family) && pkg !== home;
  const evidence: MiscenteringEvidence[] = [];
  const shareRows = (
    family: MiscenteringEvidenceKind,
    rows: PackageShare[],
    metric: string,
    source: MiscenteringEvidence["source"]
  ) => {
    for (const row of [...rows]
      .sort((a, b) => b.share - a.share || a.package.localeCompare(b.package))
      .slice(0, ROWS_PER_FAMILY)) {
      evidence.push({
        kind: family,
        metric,
        package: row.package,
        source,
        supports: supports(family, row.package),
        value: row.share,
      });
    }
  };
  for (const row of [...governing]
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.package.localeCompare(b.package))
    .slice(0, ROWS_PER_FAMILY)) {
    evidence.push({
      kind: "behavioral-locality",
      metric: "governing-behavior-share",
      package: row.package,
      source: "concept-ownership",
      supports: supports("behavioral-locality", row.package),
      value: row.count / governingTotal,
    });
  }
  evidence.push({
    kind: "behavioral-locality",
    metric: "locality-shape",
    source: "concept-locality",
    supports: false,
    value: facts.locality.shape,
  });
  shareRows(
    "symbol-distribution",
    facts.representationShares,
    "representation-share",
    "concept-distribution"
  );
  shareRows(
    "consumer-gravity",
    facts.referenceShares,
    "reference-share",
    "concept-distribution"
  );
  shareRows(
    "dependency-gravity",
    dependencyShares,
    "seed-module-import-site-share",
    "boundary-interaction"
  );
  assessMiscenteringBoundary(facts, evidence, supports);
  evidence.push({
    kind: "concept-distribution",
    metric: "shapes",
    source: "concept-distribution",
    supports: supporting.includes("concept-distribution"),
    value: facts.distributionShapes,
  });
  evidence.push({
    kind: "ownership",
    metric: "alignment",
    source: "concept-ownership",
    supports: false,
    value: facts.alignment,
  });
  assessMiscenteringEntries3(facts, evolutionCenter, evidence, supports);

  assessMiscenteringEntries4(anchored, home, cautions, facts);
  assessMiscenteringCenter(centers, home, policy, cautions);
  const foreignReturns = facts.behavior.byPackage
    .filter((row) => row.package !== home)
    .reduce((sum, row) => sum + row.byKind.return, 0);
  if (contract && facts.contractWithoutImplementations && foreignReturns > 0) {
    cautions.push({
      detail: `no \`implements\` names this ${facts.seed.kind}; ${foreignReturns} foreign function(s) returning it may be adapter factories, which structural evidence cannot tell from governing behavior`,
      kind: "unobserved-conformance",
    });
  }
  if (consumptionHeavy) {
    cautions.push({
      detail: `${facts.behavior.weak} source behaviors accept or construct the concept beside ${facts.behavior.strong} that implement, convert, or return it`,
      kind: "consumption-heavy",
    });
  }
  if (facts.intent.representationBoundaries.length > 0) {
    cautions.push({
      detail: `${facts.intent.representationBoundaries.length} overlap partner(s) with converters in another package; a semantic/persistence split may be intentional`,
      kind: "representation-boundary",
    });
  }

  const { name } = facts.concept;

  const summary: string = assessMiscenteringEntries5(
    signal,
    name,
    home,
    homeGravity,
    top,
    supporting,
    foreignBehaviorShare,
    governing,
    centers,
    policy
  );

  return {
    finding: {
      anchored: anchored.has(home),
      cautions,
      concept: facts.concept,
      declaredHome: {
        anchored: anchored.has(home),
        module: facts.seed.module,
        package: home,
        ...(facts.intent.anchorReason !== undefined && {
          anchorReason: facts.intent.anchorReason,
        }),
      },
      evidence,
      evidenceConfidence,
      gravityFamilies,
      id: facts.concept.id,
      mismatch,
      observedCenters: centers,
      signal,
      summary,
      supportingFamilies: supporting,
      weights,
    },
    outcome: "finding",
  };
}

function assessMiscenteringEntries5(
  signal: MiscenteringSignal,
  name: string,
  home: string,
  homeGravity: number,
  top: ObservedCenter,
  supporting: MiscenteringEvidenceKind[],
  foreignBehaviorShare: number,
  governing: GoverningBehavior[],
  centers: ObservedCenter[],
  policy: {
    gravity: {
      weights: {
        "behavioral-locality": number;
        "symbol-distribution": number;
        "consumer-gravity": number;
      };
    };
    minEvidenceFamilies: number;
    minFamilyShare: number;
    external: { minAlternativeGravity: number; minMismatch: number };
    split: { maxTopGravity: number; minShare: number; minPackages: number };
    drift: { minForeignShare: number; minForeignBehaviors: number };
    report: { topFindings: number };
  }
): string {
  let summary: string;
  if (signal === "external-gravity") {
    summary = `${name} is declared in ${home} (${percent(homeGravity)}) while gravity points to ${top.target} (${percent(top.gravity)}) across ${supporting.join(", ")}`;
  } else if (signal === "boundary-drift") {
    summary = `${name} keeps its symbols in ${home} while ${percent(foreignBehaviorShare)} of governing behavior sits in ${governing
      .filter((row) => row.package !== home && row.count > 0)
      .map((row) => row.package)
      .join(", ")}`;
  } else {
    summary = `${name} has no dominant observed center: ${centers
      .filter((center) => center.gravity >= policy.split.minShare)
      .map((center) => `${center.target} ${percent(center.gravity)}`)
      .join(", ")}`;
  }
  return summary;
}

function assessMiscenteringCenter(
  centers: ObservedCenter[],
  home: string,
  policy: {
    gravity: {
      weights: {
        "behavioral-locality": number;
        "symbol-distribution": number;
        "consumer-gravity": number;
      };
    };
    minEvidenceFamilies: number;
    minFamilyShare: number;
    external: { minAlternativeGravity: number; minMismatch: number };
    split: { maxTopGravity: number; minShare: number; minPackages: number };
    drift: { minForeignShare: number; minForeignBehaviors: number };
    report: { topFindings: number };
  },
  cautions: MiscenteringCaution[]
) {
  for (const center of centers) {
    if (
      center.target !== home &&
      center.anchored &&
      center.gravity >= policy.split.minShare
    ) {
      cautions.push({
        detail: `${center.target} holds ${percent(center.gravity)} of gravity and is anchored`,
        kind: "observed-center-anchored",
      });
    }
  }
}

function assessMiscenteringEntries4(
  anchored: Set<string>,
  home: string,
  cautions: MiscenteringCaution[],
  facts: RecenteringFacts
) {
  if (anchored.has(home)) {
    cautions.push({
      detail: `${home} is anchored${facts.intent.anchorReason === undefined ? "" : ` (${facts.intent.anchorReason})`}; treat this as architecture evidence, not a relocation suggestion`,
      kind: "declared-home-anchored",
    });
  }
}

function assessMiscenteringEntries3(
  facts: RecenteringFacts,
  evolutionCenter: string | undefined,
  evidence: MiscenteringEvidence[],
  supports: (family: MiscenteringEvidenceKind, pkg?: string) => boolean
) {
  for (const [metric, pkg] of [
    ["representation-center", facts.placement.representationCenter],
    ["usage-center", facts.placement.usageCenter],
    ["evolution-center", evolutionCenter],
  ] as const) {
    if (pkg === undefined) {
      continue;
    }
    evidence.push({
      kind: "ownership",
      metric,
      package: pkg,
      source: "concept-ownership",
      supports: metric === "evolution-center" && supports("ownership", pkg),
      value: pkg,
    });
  }
}

function assessMiscenteringBoundary(
  facts: RecenteringFacts,
  evidence: MiscenteringEvidence[],
  supports: (family: MiscenteringEvidenceKind, pkg?: string) => boolean
) {
  for (const boundary of facts.boundaries) {
    const both =
      boundary.conceptImportingModules.length > 0 &&
      boundary.conceptImportedModules.length > 0;
    evidence.push({
      kind: "boundary-crossing",
      metric: both ? "concept-modules-on-both-sides" : "boundary-edge",
      package: boundary.foreignPackage,
      source: "boundary-interaction",
      supports: both && supports("boundary-crossing", boundary.foreignPackage),
      value: [
        ...boundary.conceptImportingModules,
        ...boundary.conceptImportedModules,
      ],
    });
  }
}

function assessMiscenteringFamily(
  gravityFamilies: MiscenteringGravityFamily[],
  shares: Record<MiscenteringGravityFamily, PackageShare[]>,
  packages: Set<string>
) {
  for (const family of gravityFamilies) {
    for (const row of shares[family]) {
      packages.add(row.package);
    }
  }
}

function assessMiscenteringEntries2(
  initialSignal: MiscenteringSignal | undefined,
  consumptionHeavy: boolean,
  centers: ObservedCenter[],
  policy: {
    gravity: {
      weights: {
        "behavioral-locality": number;
        "symbol-distribution": number;
        "consumer-gravity": number;
      };
    };
    minEvidenceFamilies: number;
    minFamilyShare: number;
    external: { minAlternativeGravity: number; minMismatch: number };
    split: { maxTopGravity: number; minShare: number; minPackages: number };
    drift: { minForeignShare: number; minForeignBehaviors: number };
    report: { topFindings: number };
  },
  behaviorShares: PackageShare[],
  minShare: number,
  facts: RecenteringFacts,
  initialSupporting: MiscenteringEvidenceKind[],
  initialMagnitude: number
): {
  signal: MiscenteringSignal | undefined;
  supporting: MiscenteringEvidenceKind[];
  magnitude: number;
} {
  let magnitude = initialMagnitude;
  let supporting = initialSupporting;
  let signal = initialSignal;
  if (
    signal === undefined &&
    !consumptionHeavy &&
    centers.every((center) => center.gravity < policy.split.maxTopGravity) &&
    centers.filter((center) => center.gravity >= policy.split.minShare)
      .length >= policy.split.minPackages &&
    divided(
      behaviorShares,
      minShare,
      policy.split.minShare,
      policy.split.minPackages
    )
  ) {
    const second: MiscenteringEvidenceKind[] = [];
    if (
      divided(
        facts.representationShares,
        minShare,
        policy.split.minShare,
        policy.split.minPackages
      )
    ) {
      second.push("symbol-distribution");
    }
    if (
      divided(
        facts.referenceShares,
        minShare,
        policy.split.minShare,
        policy.split.minPackages
      )
    ) {
      second.push("consumer-gravity");
    }
    if (
      facts.distributionShapes.includes("reference-distributed") ||
      facts.distributionShapes.includes("implementation-split")
    ) {
      second.push("concept-distribution");
    }
    if (second.length + 1 >= policy.minEvidenceFamilies) {
      signal = "split-gravity";
      supporting = ["behavioral-locality", ...second];
      magnitude = 1 - (centers[0]?.gravity ?? 0);
    }
  }
  return { magnitude, signal, supporting };
}

function assessMiscenteringEntries(
  top: ObservedCenter,
  policy: {
    gravity: {
      weights: {
        "behavioral-locality": number;
        "symbol-distribution": number;
        "consumer-gravity": number;
      };
    };
    minEvidenceFamilies: number;
    minFamilyShare: number;
    external: { minAlternativeGravity: number; minMismatch: number };
    split: { maxTopGravity: number; minShare: number; minPackages: number };
    drift: { minForeignShare: number; minForeignBehaviors: number };
    report: { topFindings: number };
  },
  mismatch: number,
  topSupporters: MiscenteringEvidenceKind[],
  initialSignal: MiscenteringSignal | undefined,
  initialSupporting: MiscenteringEvidenceKind[],
  initialMagnitude: number,
  facts: RecenteringFacts,
  home: string,
  minShare: number,
  foreignBehaviorShare: number,
  foreignBehaviors: number,
  crossings: RecenteringBoundaryUse[],
  evolutionCenter: string | undefined
): {
  signal: MiscenteringSignal | undefined;
  supporting: MiscenteringEvidenceKind[];
  magnitude: number;
} {
  let magnitude = initialMagnitude;
  let supporting = initialSupporting;
  let signal = initialSignal;
  if (
    top.gravity >= policy.external.minAlternativeGravity &&
    mismatch >= policy.external.minMismatch &&
    topSupporters.length >= policy.minEvidenceFamilies &&
    topSupporters.includes("behavioral-locality")
  ) {
    signal = "external-gravity";
    supporting = topSupporters;
    magnitude = clamp(mismatch / (2 * policy.external.minMismatch));
  } else if (
    pointsAt(facts.representationShares, home, minShare) &&
    foreignBehaviorShare >= policy.drift.minForeignShare &&
    foreignBehaviors >= policy.drift.minForeignBehaviors
  ) {
    const second: MiscenteringEvidenceKind[] = [];
    if (crossings.length > 0) {
      second.push("boundary-crossing");
    }
    if (evolutionCenter !== undefined && evolutionCenter !== home) {
      second.push("ownership");
    }
    if (facts.distributionShapes.includes("implementation-split")) {
      second.push("concept-distribution");
    }
    if (second.length + 1 >= policy.minEvidenceFamilies) {
      signal = "boundary-drift";
      supporting = ["behavioral-locality", ...second];
      magnitude = foreignBehaviorShare;
    }
  }
  return { magnitude, signal, supporting };
}

/** Mis-centering findings over the V8.0 facts, strongest evidence first. */
export function findMiscenteredConcepts(
  target: string,
  facts: RecenteringFacts[],
  config: AnalysisConfig = ANALYSIS_CONFIG
): MiscenteredConceptReport {
  const outcomes: MiscenteredConceptSummary["outcomes"] = {
    aligned: 0,
    "behavior-light": 0,
    finding: 0,
    unclear: 0,
    "usage-only": 0,
  };
  const bySignal: MiscenteredConceptSummary["bySignal"] = {
    "boundary-drift": 0,
    "external-gravity": 0,
    "split-gravity": 0,
  };
  const findings: MiscenteredConceptFinding[] = [];
  const assessed: MiscenteredConceptReport["assessed"] = [];
  for (const item of facts) {
    const assessment = assessMiscentering(item, config);
    outcomes[assessment.outcome] += 1;
    assessed.push({ concept: item.concept, outcome: assessment.outcome });
    if (assessment.finding !== undefined) {
      findings.push(assessment.finding);
      bySignal[assessment.finding.signal] += 1;
    }
  }
  findings.sort(
    (a, b) =>
      b.evidenceConfidence - a.evidenceConfidence ||
      b.mismatch - a.mismatch ||
      a.concept.name.localeCompare(b.concept.name)
  );
  return {
    assessed,
    findings,
    summary: {
      anchored: findings.filter((item) => item.anchored).length,
      bySignal,
      evaluated: facts.length,
      findings: findings.length,
      outcomes,
    },
    target,
  };
}
