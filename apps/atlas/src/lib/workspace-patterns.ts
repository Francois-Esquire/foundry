import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  ArchitecturalReviewDisposition,
  ArchitecturalReviewUncertaintyKind,
  RecenteringScenarioKind,
  ScenarioImpactUncertaintyKind,
} from "./types";
import type {
  WorkspaceBoundaryConceptLoad,
  WorkspaceConceptIntelligence,
  WorkspaceConceptPlacement,
} from "./workspace-concepts-types";
import type { WorkspaceGraphAnalysis } from "./workspace-graph-types";
import type {
  WorkspaceArchitecturalPatterns,
  WorkspaceArchitecturalRole,
  WorkspaceArchitecturalRoleKind,
  WorkspaceArchitectureStatement,
  WorkspaceBoundaryPattern,
  WorkspaceBoundaryPatternKind,
  WorkspaceConceptPattern,
  WorkspaceCoveragePattern,
  WorkspaceDirectionPattern,
  WorkspaceEvolutionaryPattern,
  WorkspaceEvolutionaryPatternKind,
  WorkspacePackagePairPattern,
  WorkspacePackageRoleProfile,
  WorkspacePatternCaution,
  WorkspacePatternCoverage,
  WorkspacePatternEvidence,
  WorkspacePatternEvidenceStrength,
  WorkspacePatternSupport,
  WorkspacePatternThreshold,
  WorkspaceReviewContext,
  WorkspaceReviewPattern,
} from "./workspace-patterns-types";
import type {
  WorkspaceRecenteringFinding,
  WorkspaceReport,
} from "./workspace-types";

// V9.3: recurrence over V9.2 placements, V9.1 topology, V9.0 history, and
// V8 reviews. Reads only the WorkspaceReport and its attached analyses;
// never the package reports. Every aggregate is built from the V9.2 maps
// (placements by id, directions by pair, loads by boundary), so no step
// walks every concept against every boundary.

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byId);
}

function pairId(a: string, b: string): string {
  return [a, b].sort(byId).join("|");
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list === undefined) {
      map.set(k, [item]);
    } else {
      list.push(item);
    }
  }
  return map;
}

function tally<K extends string>(values: K[]): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const value of values) {
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SUPPORT

interface Context {
  analyzed: Set<string>;
  authoritative: WorkspaceConceptPlacement[];
  concepts: WorkspaceConceptIntelligence;
  config: AnalysisConfig["workspacePatterns"];
  /** Unordered package pair → cross-package overlap ids with conversions. */
  conversions: Map<string, ConversionPair[]>;
  /** Unordered package pair → source-source member couplings crossing it. */
  couplings: Map<string, PairCouplings>;
  edges: Set<string>;
  graph: WorkspaceGraphAnalysis;
  layers: Map<string, number>;
  placements: Map<string, WorkspaceConceptPlacement>;
  reviews: ReviewIndex;
  seams: Set<string>;
  workspace: WorkspaceReport;
}

interface PairCouplings {
  concepts: Set<string>;
  ids: Map<string, number>;
  /** Coupling ids with a package-level static path in either direction. */
  withPath: Set<string>;
}

interface ConversionPair {
  bidirectional: boolean;
  converterPackages: string[];
  id: string;
  left: string;
  leftPackage: string;
  right: string;
  rightPackage: string;
}

function coverageOf(
  context: Context,
  packages: Iterable<string>
): WorkspacePatternCoverage {
  for (const pkg of packages) {
    if (!context.analyzed.has(pkg)) {
      return "partial";
    }
  }
  return "complete";
}

function supportOf(input: {
  concepts: Iterable<string>;
  packages: Iterable<string>;
  boundaries?: Iterable<string>;
  observations: WorkspacePatternEvidence[];
}): WorkspacePatternSupport {
  const concepts = sorted(input.concepts);
  const boundaries = sorted(input.boundaries ?? []);
  return {
    boundaries,
    boundaryCount: boundaries.length,
    conceptCount: concepts.length,
    concepts,
    observations: input.observations,
    packages: sorted(input.packages),
  };
}

function strengthOf(
  context: Context,
  count: number,
  minimum: number,
  support: WorkspacePatternSupport,
  coverage: WorkspacePatternCoverage
): WorkspacePatternEvidenceStrength {
  const sources = new Set(support.observations.map((o) => o.source)).size;
  const strong = count >= minimum * context.config.support.strongMultiplier;
  if (strong && sources >= 2 && coverage === "complete") {
    return "strong";
  }
  if ((count >= minimum && sources >= 2) || strong) {
    return "moderate";
  }
  return "limited";
}

function evidence(
  source: WorkspacePatternEvidence["source"],
  kind: string,
  entities: string[],
  value?: number | string | boolean
): WorkspacePatternEvidence {
  return { entities, kind, source, ...(value !== undefined && { value }) };
}

// ---------------------------------------------------------------------------
// REVIEW INDEX

interface ReviewFact {
  conceptId: string;
  declared: string;
  disposition: ArchitecturalReviewDisposition;
  dominatedBaseline: boolean;
  dominatingKinds: RecenteringScenarioKind[];
  /** Strongest observed center other than the declaring package. */
  gravityCenter: string | null;
  impactUncertainties: ScenarioImpactUncertaintyKind[];
  unmeasuredEdges: string[];
  unresolved: ArchitecturalReviewUncertaintyKind[];
}

interface ReviewIndex {
  byConcept: Map<string, ReviewFact>;
  facts: ReviewFact[];
}

/**
 * The finding's strongest observed center other than its declaring package
 * (ties lexical); the key every V8 review is clustered under. Exported so
 * projections reuse this definition instead of restating it.
 */
export function reviewGravityCenter(
  finding: WorkspaceRecenteringFinding
): string | null {
  const declared = finding.concept.package;
  const strongest = finding.observedCenters
    .filter((c) => c.target !== declared)
    .sort((a, b) => b.gravity - a.gravity || byId(a.target, b.target))[0];
  return strongest?.target ?? null;
}

function indexReviews(workspace: WorkspaceReport): ReviewIndex {
  const { findings, scenarios, impacts, reviews } =
    workspace.architecture.recentering;
  const findingById = new Map(findings.map((f) => [f.id, f]));
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const impactByScenario = new Map(impacts.map((i) => [i.scenarioId, i]));
  const facts: ReviewFact[] = [];
  for (const review of [...reviews].sort((a, b) =>
    byId(a.conceptId, b.conceptId)
  )) {
    const finding = findingById.get(review.findingId);
    const declared = finding?.concept.package ?? "";
    const gravity = finding === undefined ? null : reviewGravityCenter(finding);
    const dominators = review.dominated
      .filter((d) => d.scenarioId === review.baselineScenarioId)
      .map((d) => scenarioById.get(d.dominatedBy)?.kind)
      .filter((k): k is RecenteringScenarioKind => k !== undefined);
    const partial = review.unresolved
      .filter((u) => u.kind === "partial-simulation")
      .flatMap((u) => u.scenarioIds)
      .map((id) => impactByScenario.get(id))
      .filter((i) => i !== undefined);
    facts.push({
      conceptId: review.conceptId,
      declared,
      disposition: review.disposition,
      dominatedBaseline: dominators.length > 0,
      dominatingKinds: sorted(dominators) as RecenteringScenarioKind[],
      gravityCenter: gravity,
      impactUncertainties: sorted(
        partial.flatMap((i) => i.uncertainties)
      ) as ScenarioImpactUncertaintyKind[],
      unmeasuredEdges: sorted(partial.flatMap((i) => i.unmeasuredEdges)),
      unresolved: sorted(
        review.unresolved.map((u) => u.kind)
      ) as ArchitecturalReviewUncertaintyKind[],
    });
  }
  return { byConcept: new Map(facts.map((f) => [f.conceptId, f])), facts };
}

function reviewContextOf(
  facts: ReviewFact[]
): WorkspaceReviewContext | undefined {
  if (facts.length === 0) {
    return undefined;
  }
  return {
    credibleAlternatives: sorted(
      facts
        .filter((f) => f.disposition === "credible-alternative")
        .map((f) => f.conceptId)
    ),
    dispositions: tally(facts.map((f) => f.disposition)),
    dominatedBaselines: sorted(
      facts.filter((f) => f.dominatedBaseline).map((f) => f.conceptId)
    ),
    dominatingKinds: tally(facts.flatMap((f) => f.dominatingKinds)),
    preserved: sorted(
      facts
        .filter(
          (f) =>
            f.disposition === "preserve-current" ||
            f.disposition === "multiple-tradeoffs"
        )
        .map((f) => f.conceptId)
    ),
    reviewed: facts.length,
  };
}

function reviewsFor(
  context: Context,
  conceptIds: Iterable<string>,
  filter: (fact: ReviewFact) => boolean = () => true
): WorkspaceReviewContext | undefined {
  const facts: ReviewFact[] = [];
  for (const id of sorted(conceptIds)) {
    const fact = context.reviews.byConcept.get(id);
    if (fact !== undefined && filter(fact)) {
      facts.push(fact);
    }
  }
  return reviewContextOf(facts);
}

// ---------------------------------------------------------------------------
// CONTEXT

function buildContext(
  workspace: WorkspaceReport,
  graph: WorkspaceGraphAnalysis,
  concepts: WorkspaceConceptIntelligence,
  config: AnalysisConfig
): Context {
  const placements = new Map(concepts.concepts.map((p) => [p.concept.id, p]));
  const authoritative = concepts.concepts.filter(
    (p) => p.coverage === "authoritative"
  );
  const couplings = new Map<string, PairCouplings>();
  for (const placement of authoritative) {
    for (const coupling of placement.evolution?.strongMemberCouplings ?? []) {
      if (coupling.scope !== "cross-package") {
        continue;
      }
      const key = pairId(coupling.leftPackage, coupling.rightPackage);
      let entry = couplings.get(key);
      if (entry === undefined) {
        entry = { concepts: new Set(), ids: new Map(), withPath: new Set() };
        couplings.set(key, entry);
      }
      entry.ids.set(coupling.id, coupling.coChangeCommits);
      entry.concepts.add(placement.concept.id);
      if (
        coupling.dependencyPath.forward !== null ||
        coupling.dependencyPath.reverse !== null
      ) {
        entry.withPath.add(coupling.id);
      }
    }
  }
  const converters = new Map(
    concepts.relationships.pairs.map((p) => [p.pair, p.converterPackages])
  );
  const conversions = new Map<string, ConversionPair[]>();
  for (const overlap of workspace.concepts.overlaps) {
    if (!overlap.crossPackage || overlap.conversions.length === 0) {
      continue;
    }
    const key = pairId(overlap.left.package, overlap.right.package);
    const list = conversions.get(key) ?? [];
    list.push({
      bidirectional: overlap.bidirectionalConversion,
      converterPackages: converters.get(overlap.id) ?? [],
      id: overlap.id,
      left: overlap.left.id,
      leftPackage: overlap.left.package,
      right: overlap.right.id,
      rightPackage: overlap.right.package,
    });
    conversions.set(key, list);
  }
  for (const list of conversions.values()) {
    list.sort((a, b) => byId(a.id, b.id));
  }
  return {
    analyzed: new Set(
      workspace.packages.packages.flatMap((p) => (p.analyzed ? [p.id] : []))
    ),
    authoritative,
    concepts,
    config: config.workspacePatterns,
    conversions,
    couplings,
    edges: new Set(graph.edges.map((e) => e.id)),
    graph,
    layers: new Map(graph.packages.map((p) => [p.package, p.layer])),
    placements,
    reviews: indexReviews(workspace),
    seams: new Set(graph.seams.map((s) => s.id)),
    workspace,
  };
}

function layerOf(context: Context, pkg: string): number | null {
  return context.layers.get(pkg) ?? null;
}

function directEdge(context: Context, a: string, b: string): string | null {
  if (context.edges.has(`${a}→${b}`)) {
    return `${a}→${b}`;
  }
  if (context.edges.has(`${b}→${a}`)) {
    return `${b}→${a}`;
  }
  return null;
}

/** Concepts on each side of the conversion pairs joining `a` and `b`. */
function conversionSides(
  pairs: ConversionPair[],
  a: string,
  b: string
): { a: string[]; b: string[] } {
  return {
    a: sorted(pairs.map((p) => (p.leftPackage === a ? p.left : p.right))),
    b: sorted(pairs.map((p) => (p.leftPackage === b ? p.left : p.right))),
  };
}

/** Several distinct concepts on both sides: one concept fanning out to many partners is not a projection. */
function twoSided(pairs: ConversionPair[], a: string, b: string): boolean {
  const sides = conversionSides(pairs, a, b);
  return sides.a.length >= 2 && sides.b.length >= 2;
}

function pairCouplings(context: Context, a: string, b: string): PairCouplings {
  return (
    context.couplings.get(pairId(a, b)) ?? {
      concepts: new Set(),
      ids: new Map(),
      withPath: new Set(),
    }
  );
}

// ---------------------------------------------------------------------------
// PACKAGE ROLES

interface PackageFacts {
  /** Cross-package conversion pairs converted here. */
  conversionsOwned: ConversionPair[];
  crossPackageDeclared: WorkspaceConceptPlacement[];
  declared: WorkspaceConceptPlacement[];
  directionTargets: string[];
  foreign: Record<
    "implements" | "behaves" | "represents" | "uses" | "converts",
    WorkspaceConceptPlacement[]
  >;
  package: string;
  /** Foreign concepts whose cross-package conversion partner is declared here. */
  projected: WorkspaceConceptPlacement[];
}

function packageFacts(context: Context): Map<string, PackageFacts> {
  const facts = new Map<string, PackageFacts>();
  const factsOf = (pkg: string): PackageFacts => {
    let entry = facts.get(pkg);
    if (entry === undefined) {
      entry = {
        conversionsOwned: [],
        crossPackageDeclared: [],
        declared: [],
        directionTargets: [],
        foreign: {
          behaves: [],
          converts: [],
          implements: [],
          represents: [],
          uses: [],
        },
        package: pkg,
        projected: [],
      };
      facts.set(pkg, entry);
    }
    return entry;
  };
  for (const pkg of context.workspace.packages.packages) {
    factsOf(pkg.id);
  }
  for (const placement of context.authoritative) {
    const declared = placement.presence.declaredPackage;
    const own = factsOf(declared);
    own.declared.push(placement);
    if (placement.presence.packages.length > 1) {
      own.crossPackageDeclared.push(placement);
    }
    for (const { package: pkg, roles } of placement.presence.roles) {
      if (pkg === declared) {
        continue;
      }
      const entry = factsOf(pkg);
      for (const role of roles) {
        if (role !== "declares") {
          entry.foreign[role].push(placement);
        }
      }
    }
    for (const relationship of placement.relationships.conversions) {
      if (relationship.crossPackage) {
        factsOf(relationship.otherPackage).projected.push(placement);
      }
    }
  }
  for (const direction of context.concepts.directions) {
    factsOf(direction.from).directionTargets.push(direction.to);
  }
  for (const list of context.conversions.values()) {
    for (const pair of list) {
      for (const converter of pair.converterPackages) {
        factsOf(converter).conversionsOwned.push(pair);
      }
    }
  }
  for (const entry of facts.values()) {
    entry.directionTargets = sorted(entry.directionTargets);
    entry.projected = [...new Set(entry.projected)];
  }
  return facts;
}

function distinctDeclared(placements: WorkspaceConceptPlacement[]): string[] {
  return sorted(placements.map((p) => p.presence.declaredPackage));
}

function roleOf(
  context: Context,
  kind: WorkspaceArchitecturalRoleKind,
  pkg: string,
  concepts: WorkspaceConceptPlacement[] | string[],
  sourcePackages: string[],
  observations: WorkspacePatternEvidence[],
  minimum: number
): WorkspaceArchitecturalRole {
  const ids = concepts.map((c) => (typeof c === "string" ? c : c.concept.id));
  const support = supportOf({
    concepts: ids,
    observations,
    packages: [pkg, ...sourcePackages],
  });
  const coverage = coverageOf(context, support.packages);
  return {
    coverage,
    kind,
    package: pkg,
    sourcePackages,
    strength: strengthOf(
      context,
      support.conceptCount,
      minimum,
      support,
      coverage
    ),
    support,
  };
}

interface RoleCandidate {
  count: number;
  kind: WorkspaceArchitecturalRoleKind;
}

function packagesOf(
  context: Context,
  facts: Map<string, PackageFacts>,
  candidates: RoleCandidate[]
): WorkspacePackageRoleProfile[] {
  const { support, consumption } = context.config;
  const graphNodes = new Map(context.graph.packages.map((p) => [p.package, p]));
  const profiles = new Map(
    context.workspace.architecture.packages.map((p) => [
      p.package,
      p.profileSignals,
    ])
  );
  const loads = context.concepts.boundaries;
  /** Boundary loads corroborating a role: edges out of `pkg` carrying the role, or into it for semantic centers. */
  const corroboration = (
    pkg: string,
    role: keyof WorkspaceBoundaryConceptLoad["roles"] | "incoming"
  ): WorkspacePatternEvidence[] => {
    const edges = loads.filter((l) =>
      role === "incoming" ? l.to === pkg : l.from === pkg && l.roles[role] > 0
    );
    return edges.length === 0
      ? []
      : [
          evidence(
            "boundary",
            role === "incoming"
              ? "concept-bearing-dependents"
              : `${role}-edges`,
            edges.map((l) => l.boundaryId),
            edges.length
          ),
        ];
  };
  return [...facts.values()]
    .sort((a, b) => byId(a.package, b.package))
    .map((entry) => {
      const pkg = entry.package;
      const roles: WorkspaceArchitecturalRole[] = [];
      const node = graphNodes.get(pkg);

      const semantic = entry.crossPackageDeclared;
      candidates.push({ count: semantic.length, kind: "semantic-center" });
      if (
        semantic.length >= support.minConcepts &&
        entry.directionTargets.length >= support.minSourcePackages
      ) {
        roles.push(
          roleOf(
            context,
            "semantic-center",
            pkg,
            semantic,
            [pkg],
            [
              evidence(
                "workspace-concepts",
                "declared-cross-package",
                [pkg],
                semantic.length
              ),
              evidence(
                "workspace-concepts",
                "direction-targets",
                entry.directionTargets,
                entry.directionTargets.length
              ),
              ...corroboration(pkg, "incoming"),
            ],
            support.minConcepts
          )
        );
      }

      const implemented = entry.foreign.implements;
      const implementedSources = distinctDeclared(implemented);
      candidates.push({
        count: implemented.length,
        kind: "implementation-center",
      });
      if (
        implemented.length >= support.minConcepts &&
        implementedSources.length >= support.minSourcePackages
      ) {
        roles.push(
          roleOf(
            context,
            "implementation-center",
            pkg,
            implemented,
            implementedSources,
            [
              evidence(
                "workspace-concepts",
                "implements-foreign",
                implemented.map((p) => p.concept.id),
                implemented.length
              ),
              evidence(
                "workspace-concepts",
                "semantic-sources",
                implementedSources,
                implementedSources.length
              ),
              ...corroboration(pkg, "implementation"),
            ],
            support.minConcepts
          )
        );
      }

      const projected = entry.projected.filter((p) =>
        entry.foreign.represents.includes(p)
      );
      const projectedSources = distinctDeclared(projected);
      candidates.push({
        count: projected.length,
        kind: "representation-center",
      });
      if (
        projected.length >= support.minConcepts &&
        projectedSources.length >= support.minSourcePackages
      ) {
        roles.push(
          roleOf(
            context,
            "representation-center",
            pkg,
            projected,
            projectedSources,
            [
              evidence(
                "workspace-concepts",
                "represents-foreign-with-conversion",
                projected.map((p) => p.concept.id),
                projected.length
              ),
              evidence(
                "boundary",
                "conversion-pairs",
                sorted(
                  projected.flatMap((p) =>
                    p.relationships.conversions
                      .filter((r) => r.otherPackage === pkg)
                      .map((r) => r.pair)
                  )
                )
              ),
              ...corroboration(pkg, "representation"),
            ],
            support.minConcepts
          )
        );
      }

      const converted = sorted(
        entry.conversionsOwned.flatMap((pair) => [
          ...(pair.leftPackage === pkg ? [] : [pair.left]),
          ...(pair.rightPackage === pkg ? [] : [pair.right]),
        ])
      );
      const convertedSources = sorted(
        entry.conversionsOwned.flatMap((pair) =>
          [pair.leftPackage, pair.rightPackage].filter((p) => p !== pkg)
        )
      );
      candidates.push({ count: converted.length, kind: "conversion-center" });
      if (
        converted.length >= support.minConcepts &&
        convertedSources.length >= support.minSourcePackages
      ) {
        roles.push(
          roleOf(
            context,
            "conversion-center",
            pkg,
            converted,
            convertedSources,
            [
              evidence(
                "workspace-concepts",
                "converts-foreign",
                converted,
                converted.length
              ),
              evidence(
                "boundary",
                "conversion-pairs",
                entry.conversionsOwned.map((p) => p.id),
                entry.conversionsOwned.length
              ),
              ...corroboration(pkg, "conversion"),
            ],
            support.minConcepts
          )
        );
      }

      const used = entry.foreign.uses;
      const usedSources = distinctDeclared(used);
      candidates.push({ count: used.length, kind: "consumption-center" });
      if (
        used.length >= consumption.minConcepts &&
        usedSources.length >= consumption.minSourcePackages
      ) {
        roles.push(
          roleOf(
            context,
            "consumption-center",
            pkg,
            used,
            usedSources,
            [
              evidence(
                "workspace-concepts",
                "uses-foreign",
                used.map((p) => p.concept.id),
                used.length
              ),
              evidence(
                "workspace-concepts",
                "semantic-sources",
                usedSources,
                usedSources.length
              ),
              ...corroboration(pkg, "semanticUse"),
            ],
            consumption.minConcepts
          )
        );
      }

      const foreignSources = sorted(
        Object.values(entry.foreign).flatMap(distinctDeclared)
      );
      const reviews = reviewsFor(
        context,
        entry.declared.map((p) => p.concept.id)
      );
      return {
        analyzed: context.analyzed.has(pkg),
        counts: {
          conversionsOwned: entry.conversionsOwned.length,
          declared: entry.declared.length,
          declaredCrossPackage: semantic.length,
          directionTargets: entry.directionTargets.length,
          foreignBehaved: entry.foreign.behaves.length,
          foreignConverted: entry.foreign.converts.length,
          foreignImplemented: implemented.length,
          foreignRepresented: entry.foreign.represents.length,
          foreignSources: foreignSources.length,
          foreignUsed: used.length,
        },
        package: pkg,
        roles,
        ...(node !== undefined && {
          graph: {
            articulation: node.articulation,
            dependencyReachShare: node.reach.dependencyShare,
            dependentReachShare: node.reach.dependentShare,
            fanIn: node.direct.fanIn,
            fanOut: node.direct.fanOut,
            layer: node.layer,
            role: node.role,
          },
        }),
        profileSignals: [...(profiles.get(pkg) ?? [])],
        ...(reviews !== undefined && { reviews }),
      };
    });
}

// ---------------------------------------------------------------------------
// PACKAGE PAIRS

function pairsOf(context: Context): WorkspacePackagePairPattern[] {
  const { support } = context.config;
  const grouped = group(
    context.concepts.directions,
    (d) => `${d.from}→${d.to}`
  );
  return [...grouped.entries()]
    .sort(([a], [b]) => byId(a, b))
    .map(([id, directions]) => {
      const first = directions[0];
      if (first === undefined) {
        throw new Error(`empty direction group ${id}`);
      }
      const { from, to } = first;
      const ofKind = (kind: (typeof first)["kind"]) =>
        sorted(
          directions.filter((d) => d.kind === kind).flatMap((d) => d.concepts)
        );
      const conceptRoles = {
        behavior: ofKind("semantic-to-behavior"),
        conversion: ofKind("semantic-to-conversion"),
        implementation: ofKind("semantic-to-implementation"),
        representation: ofKind("semantic-to-representation"),
        usage: ofKind("semantic-to-usage"),
      };
      const all = sorted(Object.values(conceptRoles).flat());
      const couplings = pairCouplings(context, from, to);
      const conversions = context.conversions.get(pairId(from, to)) ?? [];
      const conversionPairs = conversions.map((p) => p.id);
      const reviews = reviewsFor(context, all, (f) => f.gravityCenter === to);
      const patterns: WorkspaceDirectionPattern[] = [];
      const observations: WorkspacePatternEvidence[] = [
        evidence("workspace-concepts", "semantic-direction", [id], all.length),
      ];
      if (conceptRoles.implementation.length >= support.minConcepts) {
        patterns.push("implementation-channel");
        observations.push(
          evidence(
            "workspace-concepts",
            "implementation",
            conceptRoles.implementation,
            conceptRoles.implementation.length
          )
        );
      }
      if (
        conceptRoles.representation.length >= support.minConcepts &&
        twoSided(conversions, from, to) &&
        conversionPairs.length >= support.minConversionPairs
      ) {
        patterns.push("representation-projection");
        observations.push(
          evidence(
            "boundary",
            "conversion-pairs",
            conversionPairs,
            conversionPairs.length
          )
        );
      }
      if (conceptRoles.usage.length >= support.minConcepts) {
        patterns.push("repeated-consumption");
        observations.push(
          evidence(
            "workspace-concepts",
            "usage",
            conceptRoles.usage,
            conceptRoles.usage.length
          )
        );
      }
      if (
        reviews !== undefined &&
        reviews.reviewed >= support.minReviewedConcepts
      ) {
        const contested = reviews.dominatedBaselines.length;
        const preserved = reviews.preserved.length;
        if (contested >= support.minReviewedConcepts && preserved === 0) {
          patterns.push("repeated-externalization");
        } else if (
          preserved >= support.minReviewedConcepts &&
          contested === 0
        ) {
          patterns.push("stable-responsibility-split");
        } else if (contested > 0 && preserved > 0) {
          patterns.push("mixed");
        }
        observations.push(
          evidence(
            "v8-review",
            "dispositions",
            [...reviews.dominatedBaselines, ...reviews.preserved],
            reviews.reviewed
          )
        );
      }
      const edge = directEdge(context, from, to);
      if (edge !== null) {
        observations.push(
          evidence("workspace-graph", "dependency-edge", [edge])
        );
      }
      if (couplings.ids.size > 0) {
        observations.push(
          evidence(
            "evolution",
            "cross-package-couplings",
            [...couplings.ids.keys()].sort(byId),
            couplings.ids.size
          )
        );
      }
      const pattern = supportOf({
        boundaries: edge === null ? [] : [edge],
        concepts: all,
        observations,
        packages: [from, to],
      });
      const coverage = coverageOf(context, [from, to]);
      return {
        conceptCount: all.length,
        conceptRoles,
        conversionPairs,
        evolution: {
          coChangeCommits: [...couplings.ids.values()].reduce(
            (s, n) => s + n,
            0
          ),
          concepts: sorted(couplings.concepts),
          couplings: [...couplings.ids.keys()].sort(byId),
        },
        from,
        graph: {
          directEdge: edge,
          forward: first.dependencyPath.forward,
          fromLayer: layerOf(context, from),
          reverse: first.dependencyPath.reverse,
          toLayer: layerOf(context, to),
          usageOnly: first.dependencyPath.usageOnly,
        },
        id,
        to,
        ...(reviews !== undefined && { reviews }),
        coverage,
        patterns,
        strength: strengthOf(
          context,
          all.length,
          support.minConcepts,
          pattern,
          coverage
        ),
        support: pattern,
      };
    });
}

// ---------------------------------------------------------------------------
// BOUNDARIES

function boundariesOf(context: Context): WorkspaceBoundaryPattern[] {
  const { support, boundaries: policy } = context.config;
  const minSevered = ANALYSIS_CONFIG.workspaceGraph.seams.minSeveredPairs;
  const loads = new Map<string, WorkspaceBoundaryConceptLoad>();
  for (const load of [
    ...context.concepts.boundaries,
    ...context.concepts.seams,
  ]) {
    loads.set(load.boundaryId, load);
  }
  const out: WorkspaceBoundaryPattern[] = [];
  for (const load of [...loads.values()].sort((a, b) =>
    byId(a.boundaryId, b.boundaryId)
  )) {
    const { roles, structure, volume } = load;
    const total = load.conceptCount;
    const share = (n: number) => (total === 0 ? 0 : n / total);
    const couplings = pairCouplings(context, load.from, load.to);
    const kinds: WorkspaceBoundaryPatternKind[] = [];
    const observations: WorkspacePatternEvidence[] = [
      evidence("boundary", "concept-load", [load.boundaryId], total),
    ];
    if (
      volume.importSites !== null &&
      volume.importSites >= policy.minImportSites
    ) {
      kinds.push("high-volume-channel");
      observations.push(
        evidence(
          "workspace-graph",
          "import-sites",
          [load.boundaryId],
          volume.importSites
        )
      );
    }
    if (total >= policy.minConcepts) {
      kinds.push("high-concept-diversity");
    }
    if (
      roles.behavior >= support.minConcepts &&
      share(roles.behavior) >= policy.minRoleShare
    ) {
      kinds.push("implementation-channel");
      observations.push(
        evidence(
          "workspace-concepts",
          "behavior-share",
          [load.boundaryId],
          share(roles.behavior)
        )
      );
    }
    if (
      roles.conversion >= support.minConcepts &&
      share(roles.conversion) >= policy.minRoleShare
    ) {
      kinds.push("representation-channel");
      observations.push(
        evidence(
          "workspace-concepts",
          "conversion-share",
          [load.boundaryId],
          share(roles.conversion)
        )
      );
    }
    if (
      roles.semanticUse >= support.minConcepts &&
      share(roles.semanticUse) >= policy.minRoleShare &&
      share(roles.behavior) < policy.minRoleShare
    ) {
      kinds.push("consumption-channel");
      observations.push(
        evidence(
          "workspace-concepts",
          "usage-share",
          [load.boundaryId],
          share(roles.semanticUse)
        )
      );
    }
    if (
      structure.severedPairs >= minSevered ||
      context.seams.has(load.boundaryId)
    ) {
      kinds.push("structural-seam");
      observations.push(
        evidence(
          "workspace-graph",
          "severed-pairs",
          [load.boundaryId],
          structure.severedPairs
        )
      );
    }
    if (couplings.ids.size >= support.minCouplings) {
      kinds.push("historically-reinforced");
      observations.push(
        evidence(
          "evolution",
          "cross-package-couplings",
          [...couplings.ids.keys()].sort(byId),
          couplings.ids.size
        )
      );
    }
    if (kinds.length === 0) {
      continue;
    }
    const pattern = supportOf({
      boundaries: [load.boundaryId],
      concepts: load.concepts,
      observations,
      packages: [load.from, load.to],
    });
    const coverage = coverageOf(context, [load.from, load.to]);
    out.push({
      boundaryId: load.boundaryId,
      conceptLoad: total,
      coverage,
      evolution: {
        concepts: sorted(couplings.concepts),
        couplings: [...couplings.ids.keys()].sort(byId),
      },
      from: load.from,
      graph: {
        alternativeRoutes: structure.alternativeRoutes,
        fromLayer: layerOf(context, load.from),
        importSites: volume.importSites,
        moduleEdges: volume.moduleEdges,
        seam: context.seams.has(load.boundaryId),
        severedPairs: structure.severedPairs,
        toLayer: layerOf(context, load.to),
        weakBridge: structure.weakBridge,
      },
      kinds,
      roleLoad: { ...roles },
      strength: strengthOf(
        context,
        total,
        policy.minConcepts,
        pattern,
        coverage
      ),
      support: pattern,
      to: load.to,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CONCEPT PATTERNS

interface ConceptCandidates {
  crossLayer: number[];
  externalization: number[];
  parallel: number[];
  primitive: number[];
  projection: number[];
}

function conceptPatternsOf(
  context: Context,
  candidates: ConceptCandidates
): WorkspaceConceptPattern[] {
  const { support } = context.config;
  const out: WorkspaceConceptPattern[] = [];
  const emit = (
    input: Omit<
      WorkspaceConceptPattern,
      "support" | "strength" | "coverage"
    > & {
      observations: WorkspacePatternEvidence[];
      /** Support count in the threshold's own unit (concepts, pairs, reviews). */
      count: number;
      minimum: number;
    }
  ) => {
    const { observations, count, minimum, ...rest } = input;
    const pattern = supportOf({
      concepts: rest.concepts,
      observations,
      packages: rest.packages,
    });
    const coverage = coverageOf(context, rest.packages);
    out.push({
      ...rest,
      concepts: sorted(rest.concepts),
      coverage,
      packages: sorted(rest.packages),
      strength: strengthOf(context, count, minimum, pattern, coverage),
      support: pattern,
    });
  };

  // Parallel implementations: families implemented in the contract package
  // and in the same external package(s).
  const families = context.concepts.families.filter(
    (f) => f.implementationPackages.length >= 2
  );
  for (const [key, list] of [
    ...group(families, (f) =>
      f.implementationPackages.filter((p) => p !== f.contractPackage).join("|")
    ).entries(),
  ].sort(([a], [b]) => byId(a, b))) {
    candidates.parallel.push(list.length);
    if (list.length < support.minConcepts) {
      continue;
    }
    const external = key.split("|");
    const contracts = sorted(list.map((f) => f.contractPackage));
    emit({
      concepts: list.map((f) => f.concept),
      count: list.length,
      id: `parallel-contract-implementations:${key}`,
      kind: "parallel-contract-implementations",
      minimum: support.minConcepts,
      observations: [
        evidence(
          "workspace-concepts",
          "contract-families",
          list.map((f) => f.concept),
          list.length
        ),
        evidence(
          "workspace-graph",
          "implementation-paths",
          sorted(
            list.flatMap((f) =>
              f.paths.map((p) => `${p.package}:${p.relation}`)
            )
          )
        ),
        ...(list.some((f) => f.couplings.length > 0)
          ? [
              evidence(
                "evolution",
                "family-couplings",
                sorted(list.flatMap((f) => f.couplings))
              ),
            ]
          : []),
      ],
      packages: [...contracts, ...external],
      structure: {
        contractPackages: contracts,
        externalImplementationPackages: external,
        families: list.length,
        localImplementation: list.every((f) =>
          f.implementationPackages.includes(f.contractPackage)
        ),
      },
      ...(reviewsFor(
        context,
        list.map((f) => f.concept)
      ) !== undefined && {
        reviews: reviewsFor(
          context,
          list.map((f) => f.concept)
        ),
      }),
    });
  }

  // Conversion projection: repeated explicit converters between two packages,
  // with several distinct concepts on each side (one concept fanning out to
  // many partners is not a projection).
  for (const [key, pairs] of [...context.conversions.entries()].sort(
    ([a], [b]) => byId(a, b)
  )) {
    const [a = "", b = ""] = key.split("|");
    const { a: sideA, b: sideB } = conversionSides(pairs, a, b);
    const qualifies = twoSided(pairs, a, b);
    candidates.projection.push(qualifies ? pairs.length : 0);
    if (!qualifies || pairs.length < support.minConversionPairs) {
      continue;
    }
    const converters = sorted(pairs.flatMap((p) => p.converterPackages));
    emit({
      concepts: [...sideA, ...sideB],
      count: pairs.length,
      id: `cross-package-conversion-projection:${key}`,
      kind: "cross-package-conversion-projection",
      minimum: support.minConversionPairs,
      observations: [
        evidence(
          "boundary",
          "conversion-pairs",
          pairs.map((p) => p.id),
          pairs.length
        ),
        ...(directEdge(context, a, b) === null
          ? []
          : [
              evidence("workspace-graph", "dependency-edge", [
                directEdge(context, a, b) ?? "",
              ]),
            ]),
        ...(pairCouplings(context, a, b).ids.size > 0
          ? [
              evidence(
                "evolution",
                "cross-package-couplings",
                [...pairCouplings(context, a, b).ids.keys()].sort(byId),
                pairCouplings(context, a, b).ids.size
              ),
            ]
          : []),
      ],
      packages: [a, b, ...converters],
      structure: {
        bidirectionalPairs: pairs.filter((p) => p.bidirectional).length,
        converterPackages: converters,
        leftConcepts: sideA.length,
        packages: [a, b],
        pairs: pairs.length,
        rightConcepts: sideB.length,
      },
    });
  }

  // Shared primitives: behavior-light concepts used upward by several packages.
  const primitives = context.authoritative.filter(
    (p) =>
      p.presence.behaviorPackages.length === 0 &&
      p.presence.implementationPackages.length === 0 &&
      p.propagation === "upstream" &&
      p.presence.roles.filter(
        (r) =>
          r.package !== p.presence.declaredPackage && r.roles.includes("uses")
      ).length >= 2
  );
  for (const [pkg, list] of [
    ...group(primitives, (p) => p.presence.declaredPackage).entries(),
  ].sort(([a], [b]) => byId(a, b))) {
    candidates.primitive.push(list.length);
    if (list.length < support.minConcepts) {
      continue;
    }
    const consumers = sorted(
      list
        .flatMap((p) =>
          p.presence.roles
            .filter((r) => r.roles.includes("uses"))
            .map((r) => r.package)
        )
        .filter((c) => c !== pkg)
    );
    emit({
      concepts: list.map((p) => p.concept.id),
      count: list.length,
      id: `shared-semantic-primitive:${pkg}`,
      kind: "shared-semantic-primitive",
      minimum: support.minConcepts,
      observations: [
        evidence(
          "workspace-concepts",
          "behavior-light-upstream",
          list.map((p) => p.concept.id),
          list.length
        ),
        evidence(
          "workspace-graph",
          "consumer-packages",
          consumers,
          consumers.length
        ),
      ],
      packages: [pkg, ...consumers],
      structure: {
        consumerPackages: consumers,
        declaredPackage: pkg,
        layer: layerOf(context, pkg) ?? -1,
      },
    });
  }

  // Cross-layer contracts: responsibility spread across layers, per declaring package.
  const crossLayer = context.authoritative.filter((p) =>
    p.shapes.includes("cross-layer")
  );
  for (const [pkg, list] of [
    ...group(crossLayer, (p) => p.presence.declaredPackage).entries(),
  ].sort(([a], [b]) => byId(a, b))) {
    candidates.crossLayer.push(list.length);
    if (list.length < support.minConcepts) {
      continue;
    }
    const responsibility = sorted(
      list
        .flatMap((p) => [
          ...p.presence.behaviorPackages,
          ...p.presence.implementationPackages,
        ])
        .filter((r) => r !== pkg)
    );
    emit({
      concepts: list.map((p) => p.concept.id),
      count: list.length,
      id: `cross-layer-contract:${pkg}`,
      kind: "cross-layer-contract",
      minimum: support.minConcepts,
      observations: [
        evidence(
          "workspace-concepts",
          "cross-layer",
          list.map((p) => p.concept.id),
          list.length
        ),
        evidence(
          "workspace-graph",
          "responsibility-packages",
          responsibility,
          responsibility.length
        ),
      ],
      packages: [pkg, ...responsibility],
      structure: {
        declaredPackage: pkg,
        maxResponsibilityLayerSpan: Math.max(
          ...list.map((p) => p.span.responsibilityLayerSpan ?? 0)
        ),
        responsibilityPackages: responsibility,
      },
      ...(reviewsFor(
        context,
        list.map((p) => p.concept.id)
      ) !== undefined && {
        reviews: reviewsFor(
          context,
          list.map((p) => p.concept.id)
        ),
      }),
    });
  }

  // Behavior externalization: V8 baselines dominated by re-homing behavior,
  // grouped by the competing gravity center.
  const contested = context.reviews.facts.filter(
    (f) =>
      f.dominatedBaseline &&
      f.dominatingKinds.includes("rehome-behavior") &&
      f.gravityCenter !== null
  );
  for (const [center, list] of [
    ...group(contested, (f) => f.gravityCenter ?? "").entries(),
  ].sort(([a], [b]) => byId(a, b))) {
    candidates.externalization.push(list.length);
    if (list.length < support.minReviewedConcepts) {
      continue;
    }
    const semantic = sorted(list.map((f) => f.declared));
    const ids = list.map((f) => f.conceptId);
    emit({
      concepts: ids,
      count: list.length,
      id: `repeated-behavior-externalization:${center}`,
      kind: "repeated-behavior-externalization",
      minimum: support.minReviewedConcepts,
      observations: [
        evidence("v8-review", "dominated-baselines", ids, ids.length),
        evidence(
          "workspace-concepts",
          "gravity-center-roles",
          sorted(
            ids.flatMap(
              (id) =>
                context.placements
                  .get(id)
                  ?.presence.roles.find((r) => r.package === center)?.roles ??
                []
            )
          )
        ),
      ],
      packages: [center, ...semantic],
      reviews: reviewContextOf(list),
      structure: {
        dominatingKind: "rehome-behavior",
        gravityCenter: center,
        semanticPackages: semantic,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// EVOLUTION

function evolutionaryPatternsOf(
  context: Context,
  candidates: number[]
): WorkspaceEvolutionaryPattern[] {
  const { support } = context.config;
  const out: WorkspaceEvolutionaryPattern[] = [];
  const directionConcepts = new Map<string, Set<string>>();
  for (const direction of context.concepts.directions) {
    const key = pairId(direction.from, direction.to);
    const set = directionConcepts.get(key) ?? new Set();
    for (const id of direction.concepts) {
      set.add(id);
    }
    directionConcepts.set(key, set);
  }
  for (const [key, couplings] of [...context.couplings.entries()].sort(
    ([a], [b]) => byId(a, b)
  )) {
    const [a = "", b = ""] = key.split("|");
    const ids = [...couplings.ids.keys()].sort(byId);
    candidates.push(ids.length);
    if (ids.length < support.minCouplings) {
      continue;
    }
    const concepts = sorted(couplings.concepts);
    const kinds: WorkspaceEvolutionaryPatternKind[] = [
      "repeated-cross-boundary-change",
    ];
    const observations: WorkspacePatternEvidence[] = [
      evidence("evolution", "cross-package-couplings", ids, ids.length),
    ];
    const implemented = concepts.filter((id) => {
      const p = context.placements.get(id);
      if (p === undefined) {
        return false;
      }
      const declared = p.presence.declaredPackage;
      const other = declared === a ? b : declared === b ? a : null;
      return (
        other !== null && p.presence.implementationPackages.includes(other)
      );
    });
    if (implemented.length > 0) {
      const implementationCouplings = sorted(
        implemented.flatMap((id) =>
          (context.placements.get(id)?.evolution?.strongMemberCouplings ?? [])
            .filter((c) => couplings.ids.has(c.id))
            .map((c) => c.id)
        )
      );
      if (implementationCouplings.length >= support.minCouplings) {
        kinds.push("implementation-cochange");
        observations.push(
          evidence(
            "workspace-concepts",
            "implemented-across-pair",
            implemented,
            implemented.length
          )
        );
      }
    }
    const conversions = context.conversions.get(key) ?? [];
    if (conversions.length > 0) {
      const projected = new Set(conversions.flatMap((c) => [c.left, c.right]));
      const representationCouplings = sorted(
        concepts
          .filter((id) => projected.has(id))
          .flatMap((id) =>
            (context.placements.get(id)?.evolution?.strongMemberCouplings ?? [])
              .filter((c) => couplings.ids.has(c.id))
              .map((c) => c.id)
          )
      );
      if (representationCouplings.length >= support.minCouplings) {
        kinds.push("representation-cochange");
        observations.push(
          evidence(
            "boundary",
            "conversion-pairs",
            conversions.map((c) => c.id),
            conversions.length
          )
        );
      }
    }
    const edge = directEdge(context, a, b);
    const directed = directionConcepts.get(key)?.size ?? 0;
    if (edge !== null && directed >= support.minConcepts) {
      kinds.push("static-temporal-alignment");
      observations.push(evidence("workspace-graph", "dependency-edge", [edge]));
      observations.push(
        evidence("workspace-concepts", "semantic-directions", [key], directed)
      );
    }
    if (couplings.withPath.size === 0) {
      kinds.push("static-temporal-tension");
      observations.push(evidence("workspace-graph", "no-static-path", [key]));
    }
    const pattern = supportOf({
      boundaries: edge === null ? [] : [edge],
      concepts,
      observations,
      packages: [a, b],
    });
    const coverage = coverageOf(context, [a, b]);
    out.push({
      boundaries: pattern.boundaries,
      coChangeCommits: [...couplings.ids.values()].reduce((s, n) => s + n, 0),
      concepts,
      couplings: ids,
      coverage,
      id: key,
      kinds,
      packages: [a, b],
      strength: strengthOf(
        context,
        ids.length,
        support.minCouplings,
        pattern,
        coverage
      ),
      support: pattern,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// REVIEWS AND COVERAGE

function reviewPatternsOf(context: Context): WorkspaceReviewPattern[] {
  const out: WorkspaceReviewPattern[] = [];
  const emit = (
    scope: WorkspaceReviewPattern["scope"],
    id: string,
    entityIds: string[],
    facts: ReviewFact[]
  ) => {
    const reviews = reviewContextOf(facts);
    if (reviews === undefined) {
      return;
    }
    out.push({
      entityIds,
      id,
      impactUncertainties: tally(facts.flatMap((f) => f.impactUncertainties)),
      reviews,
      scope,
      unresolvedCauses: tally(facts.flatMap((f) => f.unresolved)),
    });
  };
  const { facts } = context.reviews;
  for (const [pkg, list] of [...group(facts, (f) => f.declared).entries()].sort(
    ([a], [b]) => byId(a, b)
  )) {
    emit("package", pkg, [pkg], list);
  }
  const centered = facts.filter((f) => f.gravityCenter !== null);
  for (const [center, list] of [
    ...group(centered, (f) => f.gravityCenter ?? "").entries(),
  ].sort(([a], [b]) => byId(a, b))) {
    emit("gravity-center", center, [center], list);
  }
  for (const [key, list] of [
    ...group(
      centered,
      (f) => `${f.declared}→${f.gravityCenter ?? ""}`
    ).entries(),
  ].sort(([a], [b]) => byId(a, b))) {
    const first = list[0];
    emit(
      "direction",
      key,
      first === undefined ? [] : [first.declared, first.gravityCenter ?? ""],
      list
    );
  }
  return out;
}

function coveragePatternsOf(
  context: Context,
  packages: WorkspacePackageRoleProfile[]
): WorkspaceCoveragePattern[] {
  const out: WorkspaceCoveragePattern[] = [];
  const missing = context.workspace.ingestion.coverage.missingPackages;
  if (missing.length > 0) {
    out.push({
      concepts: [],
      count: missing.length,
      detail: `${missing.length} known packages have no report; every count is a lower bound within analyzed coverage.`,
      entities: missing,
      kind: "partial-package-coverage",
    });
  }
  if (
    context.graph.cautions.some(
      (c) => c.kind === "module-graph-cross-package-only"
    )
  ) {
    out.push({
      concepts: [],
      count: 1,
      detail:
        "Module edges are known across package boundaries only; intra-package structure is not in the workspace graph.",
      entities: [],
      kind: "cross-package-module-graph-gap",
    });
  }
  const conformance = context.reviews.facts.filter((f) =>
    f.impactUncertainties.includes("structural-conformance-unobserved")
  );
  if (conformance.length > 0) {
    out.push({
      concepts: conformance.map((f) => f.conceptId),
      count: conformance.length,
      detail: `${conformance.length} reviews stay unresolved because structural conformance of implementations is unobserved.`,
      entities: sorted(conformance.map((f) => f.declared)),
      kind: "structural-conformance-gap",
    });
  }
  const unmeasured = group(
    context.reviews.facts.flatMap((f) =>
      f.unmeasuredEdges.map((edge) => ({ concept: f.conceptId, edge }))
    ),
    (row) => row.edge
  );
  for (const [edge, rows] of [...unmeasured.entries()].sort(([a], [b]) =>
    byId(a, b)
  )) {
    out.push({
      concepts: sorted(rows.map((r) => r.concept)),
      count: rows.length,
      detail: `${rows.length} reviews could not measure ${edge}: the reviewing package's report carried no interaction data for it.`,
      entities: [edge],
      kind: "unmeasured-edge",
    });
  }
  const integration = packages.filter(
    (p) =>
      p.roles.some((r) => r.kind === "consumption-center") &&
      p.profileSignals.includes("integration-like")
  );
  if (integration.length > 0) {
    out.push({
      concepts: [],
      count: integration.length,
      detail:
        "Consumption centers with an integration-like profile; wiring behavior is not measured per concept, so integration-center is not emitted.",
      entities: integration.map((p) => p.package),
      kind: "composition-root-gap",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// STATEMENTS AND THRESHOLDS

function statementsOf(
  context: Context,
  packages: WorkspacePackageRoleProfile[],
  conceptPatterns: WorkspaceConceptPattern[]
): WorkspaceArchitectureStatement[] {
  const { support } = context.config;
  const out: WorkspaceArchitectureStatement[] = [];
  const crossPackage = context.authoritative.filter(
    (p) => p.presence.packages.length > 1
  );
  const upstream = crossPackage.filter((p) => p.propagation === "upstream");
  const downstream = crossPackage.filter((p) => p.propagation === "downstream");
  if (
    upstream.length >= support.minConcepts &&
    upstream.length > downstream.length
  ) {
    out.push({
      conceptCount: upstream.length,
      detail: `${upstream.length} cross-package concepts are declared in a lower layer than every connected role package; ${downstream.length} the reverse.`,
      kind: "semantic-upstream-consumption",
      packages: sorted(upstream.map((p) => p.presence.declaredPackage)),
      patternIds: [],
    });
  }
  const roles = (kind: WorkspaceArchitecturalRoleKind) =>
    packages.flatMap((p) => p.roles.filter((r) => r.kind === kind));
  const roleStatement = (
    kind: WorkspaceArchitectureStatement["kind"],
    role: WorkspaceArchitecturalRoleKind,
    verb: string
  ) => {
    for (const r of roles(role)) {
      out.push({
        conceptCount: r.support.conceptCount,
        detail: `${r.package} ${verb} ${r.support.conceptCount} concepts declared in ${r.sourcePackages.length} other packages.`,
        kind,
        packages: r.support.packages,
        patternIds: [`${role}:${r.package}`],
      });
    }
  };
  roleStatement(
    "downstream-implementation-convergence",
    "implementation-center",
    "implements"
  );
  roleStatement("consumption-concentration", "consumption-center", "uses");
  roleStatement("conversion-concentration", "conversion-center", "converts");
  for (const pattern of conceptPatterns) {
    if (pattern.kind === "parallel-contract-implementations") {
      out.push({
        conceptCount: pattern.concepts.length,
        detail: `${pattern.concepts.length} contract families are implemented both in their declaring package and in ${String(pattern.structure.externalImplementationPackages)}.`,
        kind: "parallel-implementation-motif",
        packages: pattern.packages,
        patternIds: [pattern.id],
      });
    } else if (pattern.kind === "cross-package-conversion-projection") {
      out.push({
        conceptCount: pattern.concepts.length,
        detail: `${String(pattern.structure.pairs)} explicit conversion pairs join ${String(pattern.structure.packages)}.`,
        kind: "conversion-projection-motif",
        packages: pattern.packages,
        patternIds: [pattern.id],
      });
    } else if (pattern.kind === "repeated-behavior-externalization") {
      out.push({
        conceptCount: pattern.concepts.length,
        detail: `${pattern.concepts.length} reviewed baselines with behavior centered in ${String(pattern.structure.gravityCenter)} are dominated by re-homing that behavior.`,
        kind: "review-tension-concentration",
        packages: pattern.packages,
        patternIds: [pattern.id],
      });
    }
  }
  return out;
}

function threshold(
  name: string,
  value: number,
  supports: number[]
): WorkspacePatternThreshold {
  const at = (n: number) => supports.filter((s) => s >= n).length;
  return {
    counts: { above: at(value + 1), at: at(value), below: at(value - 1) },
    name,
    value,
  };
}

// ---------------------------------------------------------------------------
// ENTRY

export function analyzeWorkspacePatterns(
  workspace: WorkspaceReport,
  graph: WorkspaceGraphAnalysis,
  concepts: WorkspaceConceptIntelligence,
  config: AnalysisConfig = ANALYSIS_CONFIG
): WorkspaceArchitecturalPatterns {
  const context = buildContext(workspace, graph, concepts, config);
  const policy = context.config;
  const roleCandidates: RoleCandidate[] = [];
  const packages = packagesOf(context, packageFacts(context), roleCandidates);
  const packagePairs = pairsOf(context);
  const boundaries = boundariesOf(context);
  const conceptCandidates: ConceptCandidates = {
    crossLayer: [],
    externalization: [],
    parallel: [],
    primitive: [],
    projection: [],
  };
  const conceptPatterns = conceptPatternsOf(context, conceptCandidates);
  const couplingCandidates: number[] = [];
  const evolutionaryPatterns = evolutionaryPatternsOf(
    context,
    couplingCandidates
  );
  const reviewPatterns = reviewPatternsOf(context);
  const coveragePatterns = coveragePatternsOf(context, packages);

  const loads = [...concepts.boundaries, ...concepts.seams];
  const roleSupports = (kind: WorkspaceArchitecturalRoleKind) =>
    roleCandidates.filter((c) => c.kind === kind).map((c) => c.count);
  const thresholds: WorkspacePatternThreshold[] = [
    threshold(
      "roles.semantic-center.minConcepts",
      policy.support.minConcepts,
      roleSupports("semantic-center")
    ),
    threshold(
      "roles.implementation-center.minConcepts",
      policy.support.minConcepts,
      roleSupports("implementation-center")
    ),
    threshold(
      "roles.representation-center.minConcepts",
      policy.support.minConcepts,
      roleSupports("representation-center")
    ),
    threshold(
      "roles.conversion-center.minConcepts",
      policy.support.minConcepts,
      roleSupports("conversion-center")
    ),
    threshold(
      "roles.consumption-center.minConcepts",
      policy.consumption.minConcepts,
      roleSupports("consumption-center")
    ),
    threshold(
      "pairs.implementation-channel.minConcepts",
      policy.support.minConcepts,
      packagePairs.map((p) => p.conceptRoles.implementation.length)
    ),
    threshold(
      "pairs.repeated-consumption.minConcepts",
      policy.support.minConcepts,
      packagePairs.map((p) => p.conceptRoles.usage.length)
    ),
    threshold(
      "pairs.reviewed.minReviewedConcepts",
      policy.support.minReviewedConcepts,
      packagePairs.map((p) => p.reviews?.reviewed ?? 0)
    ),
    threshold(
      "boundaries.minImportSites",
      policy.boundaries.minImportSites,
      loads.map((l) => l.volume.importSites ?? 0)
    ),
    threshold(
      "boundaries.minConcepts",
      policy.boundaries.minConcepts,
      loads.map((l) => l.conceptCount)
    ),
    threshold(
      "concepts.parallel-contract-implementations.minConcepts",
      policy.support.minConcepts,
      conceptCandidates.parallel
    ),
    threshold(
      "concepts.cross-package-conversion-projection.minConversionPairs",
      policy.support.minConversionPairs,
      conceptCandidates.projection
    ),
    threshold(
      "concepts.shared-semantic-primitive.minConcepts",
      policy.support.minConcepts,
      conceptCandidates.primitive
    ),
    threshold(
      "concepts.cross-layer-contract.minConcepts",
      policy.support.minConcepts,
      conceptCandidates.crossLayer
    ),
    threshold(
      "concepts.repeated-behavior-externalization.minReviewedConcepts",
      policy.support.minReviewedConcepts,
      conceptCandidates.externalization
    ),
    threshold(
      "evolution.minCouplings",
      policy.support.minCouplings,
      couplingCandidates
    ),
  ];

  const cautions: WorkspacePatternCaution[] = [];
  if (graph.certainty === "partial") {
    cautions.push({
      detail:
        "Package coverage is partial; patterns describe analyzed packages only.",
      entities: workspace.ingestion.coverage.missingPackages,
      kind: "partial-coverage",
    });
    cautions.push({
      detail:
        "Every support count is at least the stated number within current coverage, not a repository total.",
      entities: [],
      kind: "lower-bound-support",
    });
  }
  const unreviewedPairs = packagePairs.filter(
    (p) =>
      p.conceptCount >= policy.support.minConcepts &&
      (p.reviews?.reviewed ?? 0) < policy.support.minReviewedConcepts
  );
  if (unreviewedPairs.length > 0) {
    cautions.push({
      detail: `${unreviewedPairs.length} package pairs at pattern support have fewer than ${policy.support.minReviewedConcepts} reviewed concepts; review-dependent direction patterns are absent there, not resolved.`,
      entities: unreviewedPairs.map((p) => p.id),
      kind: "sparse-review-coverage",
    });
  }
  const wiring = coveragePatterns.find(
    (c) => c.kind === "composition-root-gap"
  );
  if (wiring !== undefined) {
    cautions.push({
      detail:
        "integration-center needs per-concept construction evidence, which the workspace model does not carry.",
      entities: wiring.entities,
      kind: "no-wiring-evidence",
    });
  }

  const strengths = [
    ...packages.flatMap((p) => p.roles.map((r) => r.strength)),
    ...packagePairs.filter((p) => p.patterns.length > 0).map((p) => p.strength),
    ...boundaries.map((b) => b.strength),
    ...conceptPatterns.map((c) => c.strength),
    ...evolutionaryPatterns.map((e) => e.strength),
  ];
  const roleCount = packages.reduce((s, p) => s + p.roles.length, 0);
  return {
    boundaries,
    cautions,
    certainty: graph.certainty,
    conceptPatterns,
    coveragePatterns,
    evolutionaryPatterns,
    packagePairs,
    packages,
    reviewPatterns,
    statements: statementsOf(context, packages, conceptPatterns),
    summary: {
      boundaryPatterns: boundaries.length,
      conceptPatterns: conceptPatterns.length,
      coveragePatterns: coveragePatterns.length,
      evolutionaryPatterns: evolutionaryPatterns.length,
      limited: strengths.filter((s) => s === "limited").length,
      moderate: strengths.filter((s) => s === "moderate").length,
      packagePairPatterns: packagePairs.filter((p) => p.patterns.length > 0)
        .length,
      packageRoles: roleCount,
      packagesWithRoles: packages.filter((p) => p.roles.length > 0).length,
      reviewPatterns: reviewPatterns.length,
      strong: strengths.filter((s) => s === "strong").length,
    },
    thresholds,
  };
}
