import type { ConceptSeedKind } from "../../../src/lib/types";
import type { WorkspaceReport } from "../../../src/lib/workspace-types";

import { WORKSPACE_SCHEMA_VERSION } from "../../../src/lib/workspace-types";

// Synthetic WorkspaceReport builder for the V9.x workspace layers. Emits
// exactly the canonical sections those analyzers read; the rest of the
// report is irrelevant to them. Shared by the concept and pattern suites.

interface Participation {
  conversions?: number;
  implementations?: number;
  references?: number;
  representations?: number;
}

interface Behavior {
  contractBehaviors?: number;
  conversionBehaviors?: number;
  implementationBehaviors?: number;
  sourceBehaviors?: number;
  storyBehaviors?: number;
  testBehaviors?: number;
}

export interface ConceptSpec {
  behavior?: Record<string, Behavior>;
  center?: {
    semantic?: string;
    representation?: string;
    usage?: string;
    behavior?: string;
    evolution?: string;
    implementations?: string[];
  };
  couplings?: string[];
  /** Extra V7.0 evidence packages with no role (re-export paths). */
  evidencePackages?: string[];
  /** Default `seed-report`. */
  foreign?: boolean;
  hotspotModules?: string[];
  id: string;
  implementsCount?: number;
  kind?: ConceptSeedKind;
  name?: string;
  package: string;
  participation?: Record<string, Participation>;
}

interface OverlapSpec {
  bidirectional?: boolean;
  /** `function@file:from>to` */
  conversions?: string[];
  left: string;
  right: string;
}

interface CouplingSpec {
  commits?: number;
  context?: "source-source" | "source-test";
  left: string;
  right: string;
}

export interface ReviewSpec {
  /** Observed centers other than the declaring package, strongest first. */
  centers?: string[];
  conceptId: string;
  disposition: string;
  /** Scenario kind whose alternative dominates the preserve-current baseline. */
  dominatedBy?: "rehome-behavior" | "rehome-semantic-center";
  unresolved?: {
    kind: string;
    uncertainties?: string[];
    unmeasuredEdges?: string[];
  }[];
}

export interface Spec {
  anchored?: string[];
  concepts: ConceptSpec[];
  couplings?: CouplingSpec[];
  /** `A→B` or `A→B:n` (module edges, default 1; 0 = usage-only). */
  edges?: string[];
  missing?: string[];
  overlaps?: OverlapSpec[];
  packages?: string[];
  /** V6 architectural profile signals per package. */
  profiles?: Record<string, string[]>;
  reviews?: ReviewSpec[];
}

function parse(edge: string): { from: string; to: string; count: number } {
  const [pair, count] = edge.split(":");
  const [from, to] = (pair ?? "").split("→");
  return {
    count: count === undefined ? 1 : Number(count),
    from: from ?? "",
    to: to ?? "",
  };
}

function packageOfModule(module: string): string {
  return module.split("/")[0] ?? module;
}

interface BuiltConcept {
  analysis: string;
  distribution?: { packages: string[] } & Record<string, unknown>;
  file: string;
  id: string;
  kind: ConceptSeedKind;
  name: string;
  observations: never[];
  overlaps: string[];
  package: string;
  provenance: { observedBy: string[] };
  [key: string]: unknown;
}

function conceptOf(spec: ConceptSpec): BuiltConcept {
  const packages = new Set<string>([
    spec.package,
    ...Object.keys(spec.participation ?? {}),
    ...Object.keys(spec.behavior ?? {}),
    ...(spec.evidencePackages ?? []),
  ]);
  const base: BuiltConcept = {
    analysis: spec.foreign ? "foreign-only" : "seed-report",
    file: spec.id.split("#")[0] ?? spec.id,
    id: spec.id,
    kind: spec.kind ?? "interface",
    name: spec.name ?? spec.id.split("#").pop() ?? spec.id,
    observations: [],
    overlaps: [],
    package: spec.package,
    provenance: { observedBy: [spec.package] },
  };
  if (spec.foreign) {
    return base;
  }
  const participation = Object.entries(spec.participation ?? {})
    .map(([pkg, p]) => ({
      conversions: p.conversions ?? 0,
      implementations: p.implementations ?? 0,
      package: pkg,
      references: p.references ?? 0,
      representations: p.representations ?? 0,
    }))
    .sort((a, b) => (a.package < b.package ? -1 : 1));
  return {
    ...base,
    distribution: {
      moduleCount: packages.size,
      packages: [...packages].sort(),
      primaryShare: null,
      references: participation.reduce((s, p) => s + p.references, 0),
      shapes: packages.size > 1 ? ["cross-package"] : ["local"],
    },
    locality: {
      anchored: false,
      behavior: Object.entries(spec.behavior ?? {})
        .map(([pkg, b]) => ({
          contractBehaviors: b.contractBehaviors ?? 0,
          conversionBehaviors: b.conversionBehaviors ?? 0,
          implementationBehaviors: b.implementationBehaviors ?? 0,
          package: pkg,
          sourceBehaviors: b.sourceBehaviors ?? 0,
          storyBehaviors: b.storyBehaviors ?? 0,
          testBehaviors: b.testBehaviors ?? 0,
        }))
        .sort((a, b) => (a.package < b.package ? -1 : 1)),
      modifiers: [],
      moduleCount: 1,
      packageBoundaryCount: 0,
      packageCount: packages.size,
      primaryPackageShare: null,
      shape: "local",
      sourceModuleCount: 1,
    },
    ownership: {
      alignment: "aligned",
      center: { implementations: [], semantic: spec.package, ...spec.center },
      participation,
      tensions: [],
    },
    relationships: { implements: spec.implementsCount ?? 0 },
    representations: {
      byPackage: participation
        .filter((p) => p.representations > 0)
        .map((p) => ({
          package: p.package,
          representations: p.representations,
        })),
      total: participation.reduce((s, p) => s + p.representations, 0),
    },
    ...((spec.couplings !== undefined || spec.hotspotModules !== undefined) && {
      evolution: {
        couplings: [...(spec.couplings ?? [])].sort(),
        hotspotModules: [...(spec.hotspotModules ?? [])].sort(),
      },
    }),
  };
}

function recenteringOf(spec: Spec) {
  const identity = (cid: string) => {
    const found = spec.concepts.find((c) => c.id === cid);
    return {
      file: cid.split("#")[0] ?? cid,
      id: cid,
      inTarget: true,
      kind: "interface",
      name: cid.split("#").pop() ?? cid,
      package: found?.package ?? "?",
    };
  };
  const reviews = spec.reviews ?? [];
  const findings = reviews.map((r) => {
    const concept = identity(r.conceptId);
    const centers = [...(r.centers ?? []), concept.package];
    return {
      anchored: false,
      concept,
      declaredHome: "target",
      evidenceConfidence: 0.6,
      id: r.conceptId,
      mismatch: 0.5,
      observedCenters: centers.map((target, i) => ({
        anchored: false,
        gravity: Number((1 - i * 0.2).toFixed(2)),
        target,
      })),
      provenance: { observedBy: [] },
      signal: "external-gravity",
    };
  });
  const scenarios = reviews.flatMap((r) => {
    const pkg = identity(r.conceptId).package;
    const base = {
      conceptId: r.conceptId,
      confidence: "moderate",
      constraints: [],
      findingId: r.conceptId,
      proposedCenter: pkg,
      provenance: { observedBy: [] },
      resolved: true,
      status: "plausible",
    };
    return [
      {
        ...base,
        id: `${r.conceptId}::preserve-current`,
        kind: "preserve-current",
      },
      ...(r.dominatedBy === undefined
        ? []
        : [
            {
              ...base,
              id: `${r.conceptId}::${r.dominatedBy}`,
              kind: r.dominatedBy,
            },
          ]),
    ];
  });
  const impacts = reviews.map((r) => ({
    certainty: { certain: 1, conditional: 0, unknown: 0 },
    changes: [],
    findingId: r.conceptId,
    provenance: { observedBy: [] },
    resolved: true,
    scenarioId: `${r.conceptId}::preserve-current`,
    status:
      (r.unresolved ?? []).length > 0 ? "partially-simulated" : "simulated",
    summary: [],
    uncertainties: [
      ...new Set((r.unresolved ?? []).flatMap((u) => u.uncertainties ?? [])),
    ].sort(),
    unmeasuredEdges: [
      ...new Set((r.unresolved ?? []).flatMap((u) => u.unmeasuredEdges ?? [])),
    ].sort(),
  }));
  return {
    findings,
    impacts,
    reviews: reviews.map((r) => {
      const baseline = `${r.conceptId}::preserve-current`;
      return {
        baselineScenarioId: baseline,
        conceptId: r.conceptId,
        disposition: r.disposition,
        dominated:
          r.dominatedBy === undefined
            ? []
            : [
                {
                  dimensions: ["behavior"],
                  dominatedBy: `${r.conceptId}::${r.dominatedBy}`,
                  evidence: [],
                  scenarioId: baseline,
                },
              ],
        findingId: r.conceptId,
        invalid: [],
        provenance: { observedBy: [] },
        resolved: true,
        scenarios: [],
        unresolved: (r.unresolved ?? []).map((u) => ({
          kind: u.kind,
          scenarioIds: [baseline],
        })),
        viable: [],
      };
    }),
    scenarios,
  };
}

export function workspace(spec: Spec): WorkspaceReport {
  const edges = (spec.edges ?? []).map(parse);
  const concepts = spec.concepts.map(conceptOf);
  const packageIds = [
    ...new Set([
      ...(spec.packages ?? []),
      ...edges.flatMap((e) => [e.from, e.to]),
      ...concepts.flatMap((c) => c.distribution?.packages ?? [c.package]),
    ]),
  ].sort();
  const missing = new Set(spec.missing ?? []);
  const anchored = new Set(spec.anchored ?? []);
  const overlaps = (spec.overlaps ?? []).map((o) => {
    const [left = "", right = ""] = [o.left, o.right].sort();
    const id = `${left}|${right}`;
    const identity = (cid: string) => {
      const found = spec.concepts.find((c) => c.id === cid);
      return {
        file: cid.split("#")[0] ?? cid,
        id: cid,
        inTarget: false,
        kind: "interface",
        name: cid.split("#").pop() ?? cid,
        package: found?.package ?? "?",
      };
    };
    return {
      bidirectionalConversion: o.bidirectional ?? false,
      conversions: (o.conversions ?? []).map((c) => {
        const [fn = "", rest = ""] = c.split("@");
        const [file = "", dir = ""] = rest.split(":");
        const [from = "", to = ""] = dir.split(">");
        return { file, from, function: fn, to };
      }),
      crossPackage: identity(left).package !== identity(right).package,
      dimensions: ["structure"],
      id,
      left: identity(left),
      provenance: { observedBy: [] },
      right: identity(right),
      shapes:
        (o.conversions ?? []).length > 0
          ? ["conversion-pair"]
          : ["projection-like"],
      verified: true,
    };
  });
  for (const concept of concepts) {
    concept.overlaps = overlaps
      .filter((o) => o.left.id === concept.id || o.right.id === concept.id)
      .map((o) => o.id)
      .sort();
    if ((spec.reviews ?? []).some((r) => r.conceptId === concept.id)) {
      concept.recentering = { findingId: concept.id, status: "candidate" };
    }
  }
  const modules = [
    ...new Set([
      ...overlaps.flatMap((o) => o.conversions.map((c) => c.file)),
      ...(spec.couplings ?? []).flatMap((c) => [c.left, c.right]),
      ...spec.concepts.flatMap((c) => c.hotspotModules ?? []),
    ]),
  ].sort();
  const couplings = (spec.couplings ?? []).map((c) => {
    const [left = "", right = ""] = [c.left, c.right].sort();
    return {
      coChangeCommits: c.commits ?? 5,
      context: c.context ?? "source-source",
      id: `${left}|${right}`,
      jaccard: 0.7,
      left,
      leftCommits: 6,
      leftConditional: 0.8,
      leftPackage: packageOfModule(left),
      provenance: { observedBy: [] },
      right,
      rightCommits: 6,
      rightConditional: 0.8,
      rightPackage: packageOfModule(right),
      scope:
        packageOfModule(left) === packageOfModule(right)
          ? "same-package"
          : "cross-package",
      staticPath: "none",
      staticRelation: "none",
      verified: true,
    };
  });
  const partial = {
    architecture: {
      packages: Object.entries(spec.profiles ?? {}).map(([pkg, signals]) => ({
        anchored: anchored.has(pkg),
        boundaryPressure: [],
        package: pkg,
        profileSignals: signals,
        provenance: { observedBy: [pkg] },
        structuralPressure: [],
      })),
      recentering: recenteringOf(spec),
    },
    boundaries: {
      boundaries: edges.map((e) => ({
        breadth: { destinationModules: 1, sourceModules: e.count },
        from: e.from,
        id: `${e.from}→${e.to}`,
        importSites: e.count * 2,
        moduleEdges: e.count,
        perspectives: { destination: {}, source: {} },
        surfaceCoverage: e.count / 10,
        symbols: {
          distinct: e.count,
          packagePublic: 10,
          references: e.count * 5,
        },
        to: e.to,
        usage: {
          bothSymbols: 0,
          namespace: "none",
          typeOnlySymbols: 0,
          valueOnlySymbols: e.count,
        },
        verified: true,
      })),
    },
    concepts: {
      byPackage: {},
      concepts: [...concepts].sort((a, b) => (a.id < b.id ? -1 : 1)),
      overlaps: overlaps.sort((a, b) => (a.id < b.id ? -1 : 1)),
    },
    evolution: {
      churn: [],
      couplings: couplings.sort((a, b) => (a.id < b.id ? -1 : 1)),
      hotspots: [],
      packageCouplings: [],
      radius: [],
    },
    graph: {
      dependencyEdges: edges.map((e) => ({
        from: e.from,
        id: `${e.from}→${e.to}`,
        moduleEdges: e.count,
        provenance: { observedBy: [e.from, e.to].sort() },
        to: e.to,
        verified: true,
      })),
      moduleEdges: [],
      modules: modules.map((id) => ({
        id,
        package: packageOfModule(id),
        provenance: { observedBy: [] },
      })),
      packages: packageIds.map((id) => ({
        analyzed: !missing.has(id),
        anchored: anchored.has(id),
        package: id,
        provenance: { observedBy: [id] },
      })),
    },
    ingestion: {
      conflicts: [],
      coverage: {
        complete: missing.size === 0,
        missingPackages: [...missing].sort(),
        packagesAnalyzed: packageIds.length - missing.size,
        packagesKnown: packageIds.length,
        population: packageIds.length,
      },
      diagnostics: [],
    },
    packages: {
      packages: packageIds.map((id) => ({
        analyzed: !missing.has(id),
        anchored: anchored.has(id),
        id,
        name: id,
        path: id,
        provenance: { observedBy: [id] },
      })),
    },
    sources: [],
    workspace: {
      packageCount: packageIds.length,
      reportCount: packageIds.length,
    },
    workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
  };
  return partial as unknown as WorkspaceReport;
}
