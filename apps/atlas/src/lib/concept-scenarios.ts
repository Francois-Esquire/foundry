import { governingBehavior } from "./concept-miscentering";
import type { RecenteringFacts } from "./concept-recentering";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  ConceptIdentity,
  MiscenteredConceptFinding,
  MiscenteredConceptReport,
  RecenteringScenario,
  RecenteringScenarioEvidence,
  RecenteringScenarioFinding,
  RecenteringScenarioKind,
  RecenteringScenarioReport,
  RecenteringScenarioSummary,
  ScenarioCandidateCenter,
  ScenarioCaution,
  ScenarioConstraint,
  ScenarioEvidenceConfidence,
  ScenarioPlacement,
  ScenarioResponsibility,
} from "./types";

/** Precedence for dedup and truncation; never a ranking. */
export const KIND_ORDER: RecenteringScenarioKind[] = [
  "preserve-current",
  "rehome-semantic-center",
  "rehome-behavior",
  "consolidate-behavior",
  "formalize-representation-boundary",
  "split-responsibility",
];

const RESPONSIBILITY_ORDER: ScenarioResponsibility[] = [
  "semantic-contract",
  "domain-behavior",
  "implementation",
  "persistence",
  "representation",
  "conversion",
  "integration",
  "consumption",
];

const DIRECTION: Record<
  RecenteringScenarioKind,
  RecenteringScenarioEvidence["supports"]
> = {
  "consolidate-behavior": "consolidate",
  "formalize-representation-boundary": "split",
  "preserve-current": "preserve",
  "rehome-behavior": "rehome",
  "rehome-semantic-center": "rehome",
  "split-responsibility": "split",
};

/** V7.2 relations strong enough to make a partner's package a supporting-family center. */
const STRONG_RELATIONS = new Set([
  "conversion",
  "near-equivalent",
  "projection",
]);

export interface ScenarioBehaviorPackage {
  adapters: number;
  construction: number;
  conversions: number;
  governing: number;
  governingShare: number;
  package: string;
}

/** A V7.2 partner in another package whose converters live there too. */
export interface ScenarioBoundary {
  concept: ConceptIdentity;
  converterPackages: string[];
  package: string;
  /** Projection-shaped partner whose package owns every converter: a stored representation with its own adapter. */
  persistenceLike: boolean;
}

/** Everything scenario generation reads; derived once per finding from V8.0/V8.1 facts. */
export interface ScenarioFacts {
  anchors: { package: string; reason?: string }[];
  behavior: ScenarioBehaviorPackage[];
  boundaries: ScenarioBoundary[];
  consumptionHeavy: boolean;
  evolutionCenter?: string;
  finding: MiscenteredConceptFinding;
  home: string;
  implementationCenters: string[];
  publicContract: boolean;
  referenceShares: { package: string; share: number }[];
  representationShares: { package: string; share: number }[];
  /** Strongly related families by the package that declares or converts them. */
  supportingFamilies: { package: string; families: string[] }[];
  unobservedConformance: boolean;
}

interface Draft {
  blocked: boolean;
  cautions: ScenarioCaution[];
  constraints: ScenarioConstraint[];
  destination: string;
  kind: RecenteringScenarioKind;
  proposed: ScenarioPlacement;
  rationale: RecenteringScenarioEvidence[];
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function deriveScenarioFacts(
  finding: MiscenteredConceptFinding,
  facts: RecenteringFacts,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ScenarioFacts {
  const governing = governingBehavior(facts);
  const total = governing.reduce((sum, row) => sum + row.count, 0);
  const rows = new Map<string, ScenarioBehaviorPackage>();
  for (const row of governing) {
    rows.set(row.package, {
      adapters: row.adapters,
      construction: row.construction,
      conversions: row.conversions,
      governing: row.count,
      governingShare: total === 0 ? 0 : row.count / total,
      package: row.package,
    });
  }
  for (const row of facts.behavior.byPackage) {
    if (rows.has(row.package) || row.byKind.construction === 0) {
      continue;
    }
    rows.set(row.package, {
      adapters: 0,
      construction: row.byKind.construction,
      conversions: 0,
      governing: 0,
      governingShare: 0,
      package: row.package,
    });
  }
  const supporting = new Map<string, string[]>();
  const add = (pkg: string, name: string) => {
    const list = supporting.get(pkg) ?? [];
    if (!list.includes(name)) {
      list.push(name);
    }
    supporting.set(pkg, list);
  };
  for (const related of facts.relatedFamilies) {
    if (!STRONG_RELATIONS.has(related.relation)) {
      continue;
    }
    add(related.concept.package, related.concept.name);
    for (const pkg of related.converterPackages) {
      add(pkg, related.concept.name);
    }
  }
  const boundaries: ScenarioBoundary[] = facts.intent.representationBoundaries
    .flatMap((context) =>
      context.overlappingConcept === undefined
        ? []
        : [{ concept: context.overlappingConcept, context }]
    )
    .map(({ concept, context }) => {
      const related = facts.relatedFamilies.find(
        (item) => item.concept.id === concept.id
      );
      const converterPackages = unique(context.converterPackages);
      return {
        concept,
        converterPackages,
        package: concept.package,
        persistenceLike:
          related?.relation === "projection" &&
          converterPackages.length > 0 &&
          converterPackages.every((pkg) => pkg === concept.package),
      };
    });
  const home = facts.placement.seedPackage;
  return {
    anchors: config.anchors.map((anchor) => ({
      package: anchor.target,
      ...(anchor.reason !== undefined && { reason: anchor.reason }),
    })),
    behavior: [...rows.values()].sort((a, b) =>
      a.package.localeCompare(b.package)
    ),
    finding,
    home,
    implementationCenters: facts.placement.implementationCenters,
    referenceShares: facts.referenceShares,
    representationShares: facts.representationShares,
    ...(facts.placement.evolutionCenter !== undefined && {
      evolutionCenter: facts.placement.evolutionCenter,
    }),
    boundaries,
    consumptionHeavy: finding.cautions.some(
      (caution) => caution.kind === "consumption-heavy"
    ),
    publicContract:
      facts.seed.packagePublic &&
      facts.referenceShares.some(
        (row) => row.package !== home && row.share > 0
      ),
    supportingFamilies: [...supporting.entries()]
      .map(([pkg, families]) => ({ families: families.sort(), package: pkg }))
      .sort((a, b) => a.package.localeCompare(b.package)),
    unobservedConformance: finding.cautions.some(
      (caution) => caution.kind === "unobserved-conformance"
    ),
  };
}

/** Responsibilities with evidence only; sorted packages, fixed order. */
function currentPlacement(facts: ScenarioFacts): ScenarioPlacement {
  const rows: Partial<Record<ScenarioResponsibility, string[]>> = {};
  rows["semantic-contract"] = [facts.home];
  const behavior = facts.behavior.filter((row) => row.governing > 0);
  if (behavior.length > 0) {
    rows["domain-behavior"] = unique(behavior.map((row) => row.package));
  }
  const implementation = unique([
    ...facts.implementationCenters,
    ...facts.behavior
      .filter((row) => row.adapters > 0)
      .map((row) => row.package),
  ]);
  if (implementation.length > 0) {
    rows.implementation = implementation;
  }
  const persistence = unique(
    facts.boundaries
      .filter((boundary) => boundary.persistenceLike)
      .map((boundary) => boundary.package)
  );
  if (persistence.length > 0) {
    rows.persistence = persistence;
  }
  const representation = unique([
    ...facts.representationShares
      .filter((row) => row.share > 0)
      .map((row) => row.package),
    ...facts.boundaries.map((boundary) => boundary.package),
  ]);
  if (representation.length > 0) {
    rows.representation = representation;
  }
  const conversion = unique([
    ...facts.boundaries.flatMap((boundary) => boundary.converterPackages),
    ...facts.behavior
      .filter((row) => row.conversions > 0)
      .map((row) => row.package),
  ]);
  if (conversion.length > 0) {
    rows.conversion = conversion;
  }
  const integration = unique(
    facts.behavior
      .filter((row) => row.governing === 0 && row.construction > 0)
      .map((row) => row.package)
  );
  if (integration.length > 0) {
    rows.integration = integration;
  }
  const consumption = unique(
    facts.referenceShares
      .filter((row) => row.share > 0)
      .map((row) => row.package)
  );
  if (consumption.length > 0) {
    rows.consumption = consumption;
  }
  return {
    responsibilities: RESPONSIBILITY_ORDER.flatMap((responsibility) => {
      const packages = rows[responsibility];
      return packages === undefined ? [] : [{ packages, responsibility }];
    }),
    semanticCenter: facts.home,
  };
}

function withResponsibilities(
  base: ScenarioPlacement,
  semanticCenter: string,
  overrides: Partial<Record<ScenarioResponsibility, string[]>>
): ScenarioPlacement {
  const rows = new Map(
    base.responsibilities.map((row) => [row.responsibility, row.packages])
  );
  for (const [responsibility, packages] of Object.entries(overrides) as [
    ScenarioResponsibility,
    string[],
  ][]) {
    rows.set(responsibility, unique(packages));
  }
  return {
    responsibilities: RESPONSIBILITY_ORDER.flatMap((responsibility) => {
      const packages = rows.get(responsibility);
      return packages === undefined || packages.length === 0
        ? []
        : [{ packages, responsibility }];
    }),
    semanticCenter,
  };
}

export function canonicalPlacement(placement: ScenarioPlacement): string {
  return [
    `semantic=${placement.semanticCenter}`,
    ...placement.responsibilities.map(
      (row) => `${row.responsibility}=${[...row.packages].sort().join(",")}`
    ),
  ].join(";");
}

function candidateCenters(
  facts: ScenarioFacts,
  config: AnalysisConfig
): ScenarioCandidateCenter[] {
  const policy = config.recentering.scenarios;
  const anchored = new Set(facts.anchors.map((anchor) => anchor.package));
  const centers = new Map<string, ScenarioCandidateCenter["reasons"]>();
  const reasonsOf = (pkg: string) => {
    const found = centers.get(pkg) ?? {};
    centers.set(pkg, found);
    return found;
  };
  reasonsOf(facts.home).semantic = true;
  for (const row of facts.behavior) {
    if (row.governingShare >= policy.minObservedCenterShare) {
      reasonsOf(row.package).behavior = row.governingShare;
    }
    if (row.adapters > 0) {
      const reasons = reasonsOf(row.package);
      reasons.implementation = (reasons.implementation ?? 0) + row.adapters;
    }
    if (row.conversions > 0) {
      const reasons = reasonsOf(row.package);
      reasons.conversion = (reasons.conversion ?? 0) + row.conversions;
    }
  }
  for (const row of facts.representationShares) {
    if (row.share >= policy.minObservedCenterShare) {
      reasonsOf(row.package).representation = row.share;
    }
  }
  for (const pkg of facts.implementationCenters) {
    const reasons = reasonsOf(pkg);
    reasons.implementation = Math.max(reasons.implementation ?? 0, 1);
  }
  if (facts.evolutionCenter !== undefined) {
    reasonsOf(facts.evolutionCenter).evolution = true;
  }
  for (const boundary of facts.boundaries) {
    for (const pkg of boundary.converterPackages) {
      const reasons = reasonsOf(pkg);
      reasons.conversion = (reasons.conversion ?? 0) + 1;
    }
  }
  for (const row of facts.supportingFamilies) {
    if (row.families.length >= policy.minSupportingFamilies) {
      reasonsOf(row.package).supportingFamilies = row.families.length;
    }
  }
  return [...centers.entries()]
    .map(([pkg, reasons]) => ({
      anchored: anchored.has(pkg),
      package: pkg,
      reasons,
    }))
    .sort((a, b) => a.package.localeCompare(b.package));
}

function confidenceOf(
  kind: RecenteringScenarioKind,
  rationale: RecenteringScenarioEvidence[],
  constraints: ScenarioConstraint[]
): ScenarioEvidenceConfidence {
  if (
    constraints.some(
      (constraint) => constraint.kind === "structural-conformance-unknown"
    )
  ) {
    return "weak";
  }
  const kinds = new Set(
    rationale
      .filter((item) => item.supports === DIRECTION[kind])
      .map((item) => item.kind)
  );
  return kinds.size >= 3 ? "strong" : kinds.size === 2 ? "moderate" : "weak";
}

function diff(
  current: ScenarioPlacement,
  proposed: ScenarioPlacement
): {
  affected: ScenarioResponsibility[];
  preserved: ScenarioResponsibility[];
} {
  const key = (placement: ScenarioPlacement, responsibility: string) =>
    placement.responsibilities
      .find((row) => row.responsibility === responsibility)
      ?.packages.join(",") ?? "";
  const affected: ScenarioResponsibility[] = [];
  const preserved: ScenarioResponsibility[] = [];
  for (const responsibility of RESPONSIBILITY_ORDER) {
    const before = key(current, responsibility);
    const after = key(proposed, responsibility);
    if (before === "" && after === "") {
      continue;
    }
    (before === after ? preserved : affected).push(responsibility);
  }
  return { affected, preserved };
}

/**
 * Evidence-backed alternatives for one V8.1 finding, beside an explicit
 * baseline. Signal-gated: external findings get both readings (the concept
 * belongs where its behavior is, or the behavior drifted out and should
 * return); drift gets consolidation toward the home and, where a V7.2
 * partner with converters exists, an explicit representation boundary;
 * split gets consolidation toward each supported center and a
 * responsibility split. No scenario is preferred, scored, or ranked.
 */
export function generateRecenteringScenarios(
  facts: ScenarioFacts,
  config: AnalysisConfig = ANALYSIS_CONFIG
): RecenteringScenarioFinding {
  const policy = config.recentering.scenarios;
  const { finding, home } = facts;
  const anchorOf = (pkg: string) =>
    facts.anchors.find((anchor) => anchor.package === pkg);
  const centers = candidateCenters(facts, config);
  const centerOf = (pkg: string) =>
    centers.find((center) => center.package === pkg);
  const behaviorOf = (pkg: string) =>
    facts.behavior.find((row) => row.package === pkg);
  const current = currentPlacement(facts);
  const homeCenter = centerOf(home);
  const homeBehaviorShare = behaviorOf(home)?.governingShare ?? 0;
  const homeRepresentation =
    facts.representationShares.find((row) => row.package === home)?.share ?? 0;
  const foreignBehavior = facts.behavior
    .filter((row) => row.package !== home && row.governing > 0)
    .sort(
      (a, b) =>
        b.governingShare - a.governingShare ||
        a.package.localeCompare(b.package)
    );
  const anchoredCenters = centers
    .filter((center) => center.anchored)
    .map((center) => center.package);

  const evidence = (
    kind: RecenteringScenarioEvidence["kind"],
    supports: RecenteringScenarioEvidence["supports"],
    detail: RecenteringScenarioEvidence["detail"],
    pkg?: string
  ): RecenteringScenarioEvidence => ({
    kind,
    ...(pkg !== undefined && { package: pkg }),
    detail,
    supports,
  });
  const anchorConstraint = (pkg: string): ScenarioConstraint | undefined => {
    const anchor = anchorOf(pkg);
    return anchor === undefined
      ? undefined
      : {
          kind: "anchor",
          package: pkg,
          reason: anchor.reason ?? "anchored package",
        };
  };
  const conformance = (): ScenarioConstraint[] =>
    facts.unobservedConformance
      ? [
          {
            concept: finding.concept.name,
            kind: "structural-conformance-unknown",
          },
        ]
      : [];
  const boundaryConstraint = (): ScenarioConstraint[] =>
    facts.boundaries.length > 0
      ? [
          {
            concepts: facts.boundaries.map((boundary) => boundary.concept.name),
            kind: "representation-boundary",
          },
        ]
      : [];
  const sharedCautions = (destination?: string): ScenarioCaution[] => {
    const cautions: ScenarioCaution[] = [];
    if (facts.unobservedConformance) {
      cautions.push({
        detail: `no \`implements\` names ${finding.concept.name}; foreign functions returning it may be adapter factories`,
        kind: "unobserved-conformance",
      });
    }
    if (facts.consumptionHeavy) {
      cautions.push({
        detail:
          "more behavior accepts or constructs the concept than governs it",
        kind: "consumption-heavy",
      });
    }
    if (destination !== undefined && destination !== home) {
      const row = behaviorOf(destination);
      if (row !== undefined && row.construction > 0) {
        cautions.push(
          row.construction >= row.governing
            ? {
                detail: `${destination} constructs the concept ${row.construction} time(s) against ${row.governing} governing behavior(s); it may be wiring rather than a semantic center`,
                kind: "integration-center",
              }
            : {
                detail: `${destination} also constructs the concept ${row.construction} time(s); composition-root detection is not available to discount wiring`,
                kind: "composition-root-unknown",
              }
        );
      }
      if (anchorOf(destination) !== undefined) {
        cautions.push({
          detail: `${destination} is anchored; it cannot be assumed to absorb responsibility`,
          kind: "observed-center-anchored",
        });
      }
    }
    return cautions;
  };
  /** Evidence at one package that supports it as a center, in the given direction. */
  const centerRationale = (
    pkg: string,
    supports: RecenteringScenarioEvidence["supports"]
  ): RecenteringScenarioEvidence[] => {
    const found: RecenteringScenarioEvidence[] = [];
    const center = centerOf(pkg);
    const row = behaviorOf(pkg);
    if (pkg === home) {
      found.push(evidence("declared-home", supports, true, pkg));
    }
    if (row !== undefined && row.governing > 0) {
      found.push(
        evidence(
          "governing-behavior-center",
          supports,
          `${percent(row.governingShare)} of governing behavior`,
          pkg
        )
      );
    }
    if (center?.reasons.representation !== undefined) {
      found.push(
        evidence(
          "representation-center",
          supports,
          `${percent(center.reasons.representation)} of representations`,
          pkg
        )
      );
    }
    if (center?.reasons.implementation !== undefined) {
      found.push(
        evidence(
          "implementation-center",
          supports,
          `${center.reasons.implementation} implementation(s)`,
          pkg
        )
      );
    }
    if (center?.reasons.supportingFamilies !== undefined) {
      const families =
        facts.supportingFamilies.find((item) => item.package === pkg)
          ?.families ?? [];
      found.push(
        evidence("supporting-family-center", supports, families.join(", "), pkg)
      );
    }
    if (center?.reasons.evolution === true) {
      found.push(
        evidence("boundary-context", supports, "evolution center", pkg)
      );
    }
    return found;
  };

  const drafts: Draft[] = [];

  const baseline: Draft = {
    blocked: false,
    cautions: [],
    constraints: [],
    destination: home,
    kind: "preserve-current",
    proposed: current,
    rationale: [],
  };
  const homeAnchor = anchorOf(home);
  if (homeAnchor !== undefined) {
    baseline.rationale.push(
      evidence(
        "anchor",
        "preserve",
        homeAnchor.reason ?? "anchored package",
        home
      )
    );
  }
  if (homeBehaviorShare >= policy.minObservedCenterShare) {
    baseline.rationale.push(
      evidence(
        "governing-behavior-center",
        "preserve",
        `${percent(homeBehaviorShare)} of governing behavior stays home`,
        home
      )
    );
  }
  if (homeCenter?.reasons.representation !== undefined) {
    baseline.rationale.push(
      evidence(
        "representation-center",
        "preserve",
        `${percent(homeRepresentation)} of representations`,
        home
      )
    );
  }
  for (const boundary of facts.boundaries) {
    baseline.rationale.push(
      evidence(
        "conversion-boundary",
        "preserve",
        `${boundary.concept.name} converts in ${boundary.converterPackages.join(", ")}`,
        boundary.package
      )
    );
  }
  if (facts.implementationCenters.length >= 2) {
    baseline.rationale.push(
      evidence(
        "implementation-center",
        "preserve",
        `${facts.implementationCenters.length} parallel implementation centers`
      )
    );
  }
  if (facts.publicContract) {
    baseline.rationale.push(
      evidence(
        "public-contract",
        "preserve",
        "package-public and consumed outside",
        home
      )
    );
  }
  if (finding.signal === "split-gravity") {
    baseline.rationale.push(
      evidence(
        "localized-current-split",
        "preserve",
        foreignBehavior
          .concat(facts.behavior.filter((row) => row.package === home))
          .filter((row) => row.governingShare >= policy.minObservedCenterShare)
          .map((row) => `${row.package} ${percent(row.governingShare)}`)
          .sort()
          .join(", ")
      )
    );
  }
  const strongestForeign = foreignBehavior[0];
  if (strongestForeign !== undefined) {
    baseline.cautions.push({
      detail: `${strongestForeign.package} holds ${percent(strongestForeign.governingShare)} of governing behavior`,
      kind: "counter-evidence",
    });
  }
  drafts.push(baseline);

  const top = finding.observedCenters.find((center) => center.target !== home);
  const topCenter = top === undefined ? undefined : centerOf(top.target);
  const semanticRehomeAllowed =
    finding.signal === "external-gravity" ||
    (finding.signal === "boundary-drift" && policy.allowWeakRehome);
  if (
    semanticRehomeAllowed &&
    top !== undefined &&
    topCenter?.reasons.behavior !== undefined
  ) {
    const destination = top.target;
    const constraints: ScenarioConstraint[] = [];
    const homeBlock = anchorConstraint(home);
    if (homeBlock !== undefined) {
      constraints.push(homeBlock);
    }
    const inbound = anchorConstraint(destination);
    if (inbound !== undefined) {
      constraints.push(inbound);
    }
    if (facts.publicContract) {
      constraints.push({ kind: "public-contract", package: home });
    }
    constraints.push(...conformance(), ...boundaryConstraint());
    // Related rows, stores, and mappers say where representations live,
    // not where the concept belongs: they qualify a center but never
    // argue for moving the semantic contract.
    const rationale = centerRationale(destination, "rehome").filter(
      (item) => item.kind !== "supporting-family-center"
    );
    const cautions = sharedCautions(destination);
    if (homeRepresentation > 0) {
      cautions.push({
        detail: `${home} still holds ${percent(homeRepresentation)} of representations`,
        kind: "counter-evidence",
      });
    }
    if (homeBehaviorShare > 0) {
      cautions.push({
        detail: `${home} still holds ${percent(homeBehaviorShare)} of governing behavior`,
        kind: "counter-evidence",
      });
    }
    drafts.push({
      blocked: homeBlock !== undefined,
      cautions,
      constraints,
      destination,
      kind: "rehome-semantic-center",
      proposed: withResponsibilities(current, destination, {
        "semantic-contract": [destination],
      }),
      rationale,
    });
  }

  if (finding.signal === "external-gravity" && top !== undefined) {
    const constraints: ScenarioConstraint[] = [];
    const outbound = anchorConstraint(top.target);
    if (outbound !== undefined) {
      constraints.push(outbound);
    }
    constraints.push(...conformance(), ...boundaryConstraint());
    const rationale = centerRationale(home, "rehome");
    if (homeAnchor !== undefined) {
      rationale.push(
        evidence(
          "anchor",
          "rehome",
          homeAnchor.reason ?? "anchored package",
          home
        )
      );
    }
    if (facts.publicContract) {
      rationale.push(
        evidence(
          "public-contract",
          "rehome",
          "package-public and consumed outside",
          home
        )
      );
    }
    const cautions = sharedCautions();
    cautions.push({
      detail: `${top.target} holds ${percent(behaviorOf(top.target)?.governingShare ?? 0)} of governing behavior`,
      kind: "counter-evidence",
    });
    drafts.push({
      blocked: false,
      cautions,
      constraints,
      destination: home,
      kind: "rehome-behavior",
      proposed: withResponsibilities(current, home, {
        "domain-behavior": [home],
      }),
      rationale,
    });
  }

  const consolidationTargets =
    finding.signal === "boundary-drift"
      ? [home]
      : finding.signal === "split-gravity"
        ? facts.behavior
            .filter(
              (row) => row.governingShare >= policy.minObservedCenterShare
            )
            .map((row) => row.package)
        : [];
  for (const destination of consolidationTargets) {
    const constraints: ScenarioConstraint[] = [];
    for (const row of facts.behavior) {
      if (row.package === destination || row.governing === 0) {
        continue;
      }
      const vacated = anchorConstraint(row.package);
      if (vacated !== undefined) {
        constraints.push(vacated);
      }
    }
    if (destination !== home) {
      const inbound = anchorConstraint(destination);
      if (inbound !== undefined) {
        constraints.push(inbound);
      }
    }
    constraints.push(...conformance());
    if (
      facts.boundaries.some((boundary) =>
        boundary.converterPackages.some(
          (pkg) => pkg !== destination && (behaviorOf(pkg)?.governing ?? 0) > 0
        )
      )
    ) {
      constraints.push(...boundaryConstraint());
    }
    const rationale = centerRationale(destination, "consolidate");
    const cautions = sharedCautions(destination);
    const strongestOther = foreignBehavior
      .concat(facts.behavior.filter((row) => row.package === home))
      .filter((row) => row.package !== destination && row.governing > 0)
      .sort((a, b) => b.governingShare - a.governingShare)[0];
    if (strongestOther !== undefined) {
      cautions.push({
        detail: `${strongestOther.package} holds ${percent(strongestOther.governingShare)} of governing behavior`,
        kind: "counter-evidence",
      });
    }
    drafts.push({
      blocked: false,
      cautions,
      constraints,
      destination,
      kind: "consolidate-behavior",
      proposed: withResponsibilities(current, home, {
        "domain-behavior": [destination],
      }),
      rationale,
    });
  }

  if (facts.boundaries.length > 0) {
    const converterPackages = unique(
      facts.boundaries.flatMap((boundary) => boundary.converterPackages)
    );
    const rationale: RecenteringScenarioEvidence[] = [
      evidence("declared-home", "split", true, home),
    ];
    for (const boundary of facts.boundaries) {
      rationale.push(
        evidence(
          "conversion-boundary",
          "split",
          `${boundary.concept.name} converts in ${boundary.converterPackages.join(", ")}`,
          boundary.package
        ),
        evidence(
          "representation-center",
          "split",
          `${boundary.concept.name} declared here`,
          boundary.package
        )
      );
    }
    const constraints: ScenarioConstraint[] = [];
    for (const row of facts.behavior) {
      if (row.conversions === 0 || converterPackages.includes(row.package)) {
        continue;
      }
      const vacated = anchorConstraint(row.package);
      if (vacated !== undefined) {
        constraints.push(vacated);
      }
    }
    drafts.push({
      blocked: false,
      cautions: sharedCautions(),
      constraints,
      destination: converterPackages.join("+"),
      kind: "formalize-representation-boundary",
      proposed: withResponsibilities(current, home, {
        conversion: converterPackages,
        persistence: facts.boundaries
          .filter((boundary) => boundary.persistenceLike)
          .map((boundary) => boundary.package),
      }),
      rationale,
    });
  }

  const foreignResponsibilityCenters = centers.filter(
    (center) =>
      center.package !== home &&
      (center.reasons.implementation !== undefined ||
        center.reasons.conversion !== undefined)
  );
  // Foreign behavior that is entirely converters reads as a conversion
  // responsibility, not domain behavior; anything beyond that stays where
  // it is. The scenario formalizes the split rather than moving behavior.
  const behaviorBeyondConversion = unique(
    facts.behavior
      .filter(
        (row) =>
          row.governing > 0 &&
          (row.package === home || row.governing > row.conversions)
      )
      .map((row) => row.package)
  );
  if (foreignResponsibilityCenters.length > 0) {
    const implementation = unique([
      ...facts.implementationCenters,
      ...centers
        .filter((center) => center.reasons.implementation !== undefined)
        .map((center) => center.package),
    ]);
    const conversion = unique(
      centers
        .filter((center) => center.reasons.conversion !== undefined)
        .map((center) => center.package)
    );
    const rationale: RecenteringScenarioEvidence[] = [
      evidence("declared-home", "split", true, home),
    ];
    for (const center of foreignResponsibilityCenters) {
      if (center.reasons.implementation !== undefined) {
        rationale.push(
          evidence(
            "implementation-center",
            "split",
            `${center.reasons.implementation} implementation(s)`,
            center.package
          )
        );
      }
      if (center.reasons.conversion !== undefined) {
        rationale.push(
          evidence(
            "conversion-boundary",
            "split",
            `${center.reasons.conversion} converter(s)`,
            center.package
          )
        );
      }
    }
    drafts.push({
      blocked: false,
      cautions: sharedCautions(),
      constraints: conformance(),
      destination: foreignResponsibilityCenters
        .map((center) => center.package)
        .join("+"),
      kind: "split-responsibility",
      proposed: withResponsibilities(current, home, {
        conversion,
        "domain-behavior": behaviorBeyondConversion,
        implementation,
      }),
      rationale,
    });
  }

  drafts.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.destination.localeCompare(b.destination)
  );
  const byPlacement = new Map<string, Draft>();
  let deduplicated = 0;
  for (const draft of drafts) {
    const key = canonicalPlacement(draft.proposed);
    const kept = byPlacement.get(key);
    if (kept === undefined) {
      byPlacement.set(key, draft);
      continue;
    }
    // Constraints describe the kept draft's move; a merged draft adds only
    // its rationale and cautions.
    deduplicated += 1;
    const rationaleKey = (item: RecenteringScenarioEvidence) =>
      `${item.kind}|${item.package ?? ""}|${String(item.detail)}`;
    const seen = new Set(kept.rationale.map(rationaleKey));
    for (const item of draft.rationale) {
      const serialized = rationaleKey(item);
      if (seen.has(serialized)) {
        continue;
      }
      seen.add(serialized);
      kept.rationale.push(item);
    }
    const cautions = new Set(kept.cautions.map((item) => item.detail));
    for (const item of draft.cautions) {
      if (cautions.has(item.detail)) {
        continue;
      }
      kept.cautions.push(item);
    }
  }
  const unique_ = [...byPlacement.values()];
  const kept = unique_.slice(0, policy.maxScenariosPerFinding);
  const scenarios: RecenteringScenario[] = kept.map((draft) => {
    const { affected, preserved } = diff(current, draft.proposed);
    return {
      affectedResponsibilities: affected,
      anchorContext: {
        anchoredCenters,
        homeAnchored: homeAnchor !== undefined,
      },
      cautions: draft.cautions,
      confidence: confidenceOf(draft.kind, draft.rationale, draft.constraints),
      constraints: draft.constraints,
      current,
      findingId: finding.id,
      id: `${finding.id}::${draft.kind}::${canonicalPlacement(draft.proposed)}`,
      kind: draft.kind,
      preservedResponsibilities: preserved,
      proposed: draft.proposed,
      rationale: draft.rationale,
      status: draft.blocked
        ? "blocked"
        : draft.constraints.length > 0
          ? "constrained"
          : "plausible",
      subject: finding.concept,
    };
  });
  const alternatives = scenarios.filter(
    (scenario) => scenario.kind !== "preserve-current"
  );
  return {
    candidateCenters: centers,
    diagnostics: {
      blocked: scenarios.filter((scenario) => scenario.status === "blocked")
        .length,
      centersConsidered: centers.length,
      deduplicated,
      proposed: drafts.length,
      truncated: unique_.length - kept.length,
      ...(alternatives.length === 0 && {
        noAlternativeReason:
          drafts.length > 1
            ? "every alternative collapsed into the current arrangement"
            : centers.length <= 1
              ? "no candidate center beyond the declared home"
              : "no observed center meets the generation gates",
      }),
    },
    findingId: finding.id,
    scenarios,
    signal: finding.signal,
    subject: finding.concept,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
}

/** Scenarios for every V8.1 finding, in finding order. */
export function analyzeRecenteringScenarios(
  target: string,
  miscentered: MiscenteredConceptReport,
  facts: RecenteringFacts[],
  config: AnalysisConfig = ANALYSIS_CONFIG
): RecenteringScenarioReport {
  const factsById = new Map(facts.map((item) => [item.concept.id, item]));
  const findings: RecenteringScenarioFinding[] = [];
  for (const finding of miscentered.findings) {
    const source = factsById.get(finding.id);
    if (source === undefined) {
      throw new Error(`re-centering facts missing for ${finding.concept.name}`);
    }
    findings.push(
      generateRecenteringScenarios(
        deriveScenarioFacts(finding, source, config),
        config
      )
    );
  }
  return { findings, summary: summarize(findings, miscentered), target };
}

function summarize(
  findings: RecenteringScenarioFinding[],
  miscentered: MiscenteredConceptReport
): RecenteringScenarioSummary {
  const all = findings.flatMap((finding) => finding.scenarios);
  const byKind: RecenteringScenarioSummary["byKind"] = {
    "consolidate-behavior": 0,
    "formalize-representation-boundary": 0,
    "preserve-current": 0,
    "rehome-behavior": 0,
    "rehome-semantic-center": 0,
    "split-responsibility": 0,
  };
  const byDestination: Record<string, number> = {};
  for (const scenario of all) {
    byKind[scenario.kind] += 1;
    if (scenario.kind === "preserve-current") {
      continue;
    }
    const destination =
      scenario.kind === "rehome-semantic-center"
        ? scenario.proposed.semanticCenter
        : scenario.kind === "rehome-behavior" ||
            scenario.kind === "consolidate-behavior"
          ? (scenario.proposed.responsibilities.find(
              (row) => row.responsibility === "domain-behavior"
            )?.packages[0] ?? scenario.proposed.semanticCenter)
          : scenario.proposed.responsibilities
              .filter(
                (row) =>
                  row.responsibility === "implementation" ||
                  row.responsibility === "conversion"
              )
              .flatMap((row) => row.packages)
              .filter((pkg) => pkg !== scenario.current.semanticCenter)
              .sort()
              .join("+");
    if (destination === "") {
      continue;
    }
    byDestination[destination] = (byDestination[destination] ?? 0) + 1;
  }
  const status = (value: RecenteringScenario["status"]) =>
    all.filter((scenario) => scenario.status === value).length;
  const centerCounts = findings.map(
    (finding) => finding.candidateCenters.length
  );
  const perFinding = findings.map((finding) => finding.scenarios.length);
  const skipped: RecenteringScenarioSummary["skipped"] = {
    aligned: miscentered.summary.outcomes.aligned,
    "behavior-light": miscentered.summary.outcomes["behavior-light"],
    unclear: miscentered.summary.outcomes.unclear,
    "usage-only": miscentered.summary.outcomes["usage-only"],
  };
  return {
    baselineOnly: findings.filter((finding) =>
      finding.scenarios.every(
        (scenario) => scenario.kind === "preserve-current"
      )
    ).length,
    blocked: status("blocked"),
    blockedByAnchor: all.filter(
      (scenario) =>
        scenario.status === "blocked" &&
        scenario.constraints.some((constraint) => constraint.kind === "anchor")
    ).length,
    byDestination,
    byKind,
    candidateCenters: {
      one: centerCounts.filter((count) => count <= 1).length,
      threePlus: centerCounts.filter((count) => count >= 3).length,
      two: centerCounts.filter((count) => count === 2).length,
    },
    constrained: status("constrained"),
    constrainedByIncompleteEvidence: all.filter((scenario) =>
      scenario.constraints.some(
        (constraint) => constraint.kind === "structural-conformance-unknown"
      )
    ).length,
    findings: findings.length,
    findingsWithAlternatives: findings.filter((finding) =>
      finding.scenarios.some((scenario) => scenario.kind !== "preserve-current")
    ).length,
    plausible: status("plausible"),
    scenarios: all.length,
    scenariosPerFinding: {
      max: perFinding.length === 0 ? 0 : Math.max(...perFinding),
      p50: percentile(perFinding, 0.5),
      p90: percentile(perFinding, 0.9),
    },
    skipped,
  };
}
