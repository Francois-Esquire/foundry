import { describe, expect, it } from "vitest";
import { WORKSPACE_INTELLIGENCE_POLICY_VERSION } from "../../src/lib/config";
import { renderWorkspaceConcept } from "../../src/lib/report-workspace";
import { analyzeWorkspaceConcepts } from "../../src/lib/workspace-concepts";
import type {
  WorkspaceConceptIntelligence,
  WorkspaceConceptPlacement,
} from "../../src/lib/workspace-concepts-types";
import { analyzeWorkspaceGraph } from "../../src/lib/workspace-graph";
import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import type { Spec } from "./helpers/workspace-builder";
import { workspace } from "./helpers/workspace-builder";

const expectedTextPattern =
  /persistenceHub|domainCluster|architecturalSubsystem|driftCorridor|Score"|score"|hub|drift|subsystem/i;
const expectedTextPattern2 = /^ambiguous name Status/;

function analyze(spec: Spec): WorkspaceConceptIntelligence {
  const ws = workspace(spec);
  return analyzeWorkspaceConcepts(ws, analyzeWorkspaceGraph(ws));
}

function concept(
  analysis: WorkspaceConceptIntelligence,
  id: string
): WorkspaceConceptPlacement {
  const found = analysis.concepts.find((c) => c.concept.id === id);
  if (found === undefined) {
    throw new Error(`no concept ${id}`);
  }
  return found;
}

const REPO = "core/repo.ts#Repo";

/** app → store → core; Repo declared in core, implemented in store, used by app. */
const chain: Spec = {
  concepts: [
    {
      behavior: {
        app: { contractBehaviors: 2, sourceBehaviors: 2 },
        store: { implementationBehaviors: 5, sourceBehaviors: 5 },
      },
      center: { implementations: ["store"], semantic: "core", usage: "app" },
      id: REPO,
      implementsCount: 1,
      package: "core",
      participation: {
        app: { references: 4 },
        core: { references: 2, representations: 1 },
        store: { implementations: 1, references: 3, representations: 1 },
      },
    },
  ],
  edges: ["app→store", "store→core"],
};

describe("presence and roles", () => {
  const analysis = analyze(chain);
  const repo = concept(analysis, REPO);

  it("derives exact package role sets from canonical facts", () => {
    expect(repo.coverage).toBe("authoritative");
    expect(repo.presence).toMatchObject({
      behaviorPackages: ["store"],
      contractBehaviorPackages: ["app"],
      converterPackages: [],
      declaredPackage: "core",
      implementationPackages: ["store"],
      packages: ["app", "core", "store"],
      referencePackages: ["app", "core", "store"],
      representationPackages: ["core", "store"],
    });
    expect(repo.presence.roles).toEqual([
      { package: "app", roles: ["uses"] },
      { package: "core", roles: ["declares", "represents", "uses"] },
      {
        package: "store",
        roles: ["implements", "represents", "uses", "behaves"],
      },
    ]);
    expect(repo.extent).toMatchObject({
      implementations: 1,
      packageCount: 3,
      references: 9,
      representations: 2,
    });
  });

  it("keeps V7.3 centers and adds their graph layers", () => {
    expect(repo.centers).toMatchObject({
      graphContext: { semanticLayer: 0, usageLayer: 2 },
      implementations: ["store"],
      semantic: "core",
      usage: "app",
    });
  });
});

describe("path context", () => {
  const analysis = analyze(chain);
  const repo = concept(analysis, REPO);

  it("measures each role package against the declared package", () => {
    expect(repo.topology.paths).toEqual([
      { distance: 2, package: "app", relation: "indirect", usageOnly: false },
      { distance: 1, package: "store", relation: "direct", usageOnly: false },
    ]);
    expect(repo.flow.semanticToImplementations).toEqual([
      { distance: 1, package: "store", relation: "direct", usageOnly: false },
    ]);
    expect(repo.flow.semanticToUsage.map((p) => p.package)).toEqual([
      "app",
      "store",
    ]);
    expect(repo.propagation).toBe("upstream");
    expect(repo.shapes).toEqual([
      "downstream-implemented",
      "upstream-consumed",
    ]);
    expect(repo.span).toMatchObject({
      behaviorLayerSpan: 1,
      boundaryCount: 2,
      implementationBoundaryCount: 1,
      implementationLayerSpan: 1,
      layerSpan: 2,
      responsibilityLayerSpan: 1,
      usageLayerSpan: 2,
    });
  });

  it("keeps the conceptual direction apart from the static dependency direction", () => {
    const direction = analysis.directions.find(
      (d) => d.kind === "semantic-to-implementation"
    );
    expect(direction).toMatchObject({
      concepts: [REPO],
      count: 1,
      dependencyPath: { forward: null, reverse: 1, usageOnly: false },
      from: "core",
      to: "store",
    });
    expect(analysis.families).toEqual([
      expect.objectContaining({
        categories: [
          "cross-package-implementation",
          "downstream-implementation",
        ],
        concept: REPO,
        contractPackage: "core",
        implementationPackages: ["store"],
      }),
    ]);
  });

  it("records a reverse-directed relation instead of inventing an outward path", () => {
    const packageAnalysis2 = analyze({
      concepts: [
        {
          behavior: { A: { implementationBehaviors: 2, sourceBehaviors: 2 } },
          id: "B/b.ts#Thing",
          package: "B",
          participation: { A: { references: 1 } },
        },
      ],
      edges: ["B→A"],
    });
    const thing = concept(packageAnalysis2, "B/b.ts#Thing");
    expect(thing.topology.paths).toEqual([
      {
        distance: 1,
        package: "A",
        relation: "reverse-directed",
        usageOnly: false,
      },
    ]);
    expect(thing.propagation).toBe("downstream");
    expect(thing.shapes).not.toContain("upstream-consumed");
  });

  it("reports a disconnected implementation as a second region under complete coverage", () => {
    const packageAnalysis = analyze({
      concepts: [
        {
          id: "A/a.ts#Thing",
          package: "A",
          participation: { C: { implementations: 1 } },
        },
      ],
      packages: ["A", "C"],
    });
    const thing = concept(packageAnalysis, "A/a.ts#Thing");
    expect(thing.topology.paths).toEqual([
      {
        distance: null,
        package: "C",
        relation: "disconnected",
        usageOnly: false,
      },
    ]);
    expect(thing.topology.disconnectedPackages).toEqual(["C"]);
    expect(thing.topology.components).toEqual(["A", "C"]);
    expect(thing.shapes).toContain("multi-region");
    expect(thing.propagation).toBe("disconnected");
    expect(packageAnalysis.families[0]?.categories).toContain(
      "disconnected-implementation"
    );
  });
});

describe("representation split", () => {
  const spec: Spec = {
    concepts: [
      { id: "A/domain.ts#Domain", package: "A" },
      { id: "B/row.ts#Row", package: "B" },
    ],
    edges: ["B→A"],
    overlaps: [
      {
        conversions: ["toRow@B/convert.ts:A/domain.ts#Domain>B/row.ts#Row"],
        left: "B/row.ts#Row",
        right: "A/domain.ts#Domain",
      },
    ],
  };
  const analysis = analyze(spec);

  it("keeps both families and places the converter on the graph", () => {
    expect(analysis.concepts).toHaveLength(2);
    const domain = concept(analysis, "A/domain.ts#Domain");
    const row = concept(analysis, "B/row.ts#Row");
    expect(domain.shapes).toContain("representation-split");
    expect(row.shapes).toContain("representation-split");
    expect(domain.presence.converterPackages).toEqual(["B"]);
    expect(domain.relationships.conversions[0]?.conversions).toEqual([
      {
        direction: "outgoing",
        file: "B/convert.ts",
        function: "toRow",
        package: "B",
      },
    ]);
    expect(row.relationships.conversions[0]?.conversions[0]?.direction).toBe(
      "incoming"
    );
    expect(analysis.relationships.pairs).toEqual([
      expect.objectContaining({
        converterPackages: ["B"],
        directEdge: "B→A",
        leftPackage: "A",
        pair: "A/domain.ts#Domain|B/row.ts#Row",
        path: { forward: null, reverse: 1 },
        rightPackage: "B",
        sameComponent: true,
        sameLayer: false,
        samePackage: false,
      }),
    ]);
    expect(analysis.summary.conversionPairs).toBe(1);
  });

  it("is stable however the source observation was oriented", () => {
    const flipped = analyze({
      ...spec,
      overlaps: [
        {
          conversions: ["toRow@B/convert.ts:A/domain.ts#Domain>B/row.ts#Row"],
          left: "A/domain.ts#Domain",
          right: "B/row.ts#Row",
        },
      ],
    });
    expect(JSON.stringify(flipped)).toBe(JSON.stringify(analysis));
  });
});

describe("boundary concept load", () => {
  const analysis = analyze({
    concepts: [
      {
        id: "B/1.ts#One",
        package: "B",
        participation: { A: { references: 1 } },
      },
      {
        behavior: { A: { implementationBehaviors: 1, sourceBehaviors: 1 } },
        id: "B/2.ts#Two",
        package: "B",
        participation: { A: { implementations: 1, references: 1 } },
      },
      {
        id: "B/3.ts#Three",
        package: "B",
        participation: { A: { references: 2, representations: 1 } },
      },
      { id: "B/4.ts#Local", package: "B" },
    ],
    edges: ["A→B"],
  });

  it("counts each concept once with exact role counts", () => {
    expect(analysis.boundaries).toEqual([
      expect.objectContaining({
        boundaryId: "A→B",
        conceptCount: 3,
        concepts: ["B/1.ts#One", "B/2.ts#Two", "B/3.ts#Three"],
        roles: {
          behavior: 1,
          conversion: 0,
          implementation: 1,
          representation: 1,
          semanticUse: 3,
        },
        volume: {
          distinctSymbols: 1,
          importSites: 2,
          moduleEdges: 1,
          references: 5,
        },
      }),
    ]);
    expect(analysis.summary.conceptBearingBoundaries).toBe(1);
    expect(analysis.summary.local).toBe(1);
    expect(analysis.summary.crossPackage).toBe(3);
  });

  it("aggregates package roles and directions per ordered pair", () => {
    const a = analysis.packageRoles.find((r) => r.package === "A");
    const b = analysis.packageRoles.find((r) => r.package === "B");
    expect(a?.participating).toEqual({
      behaving: 1,
      converting: 0,
      implementing: 1,
      representing: 1,
      total: 3,
      using: 3,
    });
    expect(a?.declaredConcepts).toBe(0);
    expect(b).toMatchObject({ declaredConcepts: 4, semanticCenters: 4 });
    expect(
      analysis.directions.map((d) => [d.kind, d.from, d.to, d.count])
    ).toEqual([
      ["semantic-to-usage", "B", "A", 3],
      ["semantic-to-behavior", "B", "A", 1],
      ["semantic-to-implementation", "B", "A", 1],
      ["semantic-to-representation", "B", "A", 1],
    ]);
  });
});

describe("usage-only edges and aggregators", () => {
  it("keeps a re-export-only usage as flow context, never a structural edge", () => {
    const analysis = analyze({
      concepts: [
        {
          id: "C/c.ts#Thing",
          package: "C",
          participation: { A: { references: 2 } },
        },
      ],
      edges: ["A→B", "B→C", "A→C:0"],
    });
    const thing = concept(analysis, "C/c.ts#Thing");
    expect(thing.topology.usageOnlyEdges).toEqual(["A→C"]);
    expect(thing.topology.edges).toEqual([]);
    expect(thing.flow.semanticToUsage).toEqual([
      { distance: 2, package: "A", relation: "indirect", usageOnly: true },
    ]);
    expect(thing.cautions.map((c) => c.kind)).toContain("usage-only-flow");
    expect(analysis.directions[0]?.dependencyPath).toEqual({
      forward: null,
      reverse: 2,
      usageOnly: true,
    });
    expect(analysis.boundaries).toEqual([]);
  });

  it("does not let a re-exporting package become a behavior package", () => {
    const analysis = analyze({
      concepts: [
        {
          center: { behavior: "C", semantic: "C" },
          evidencePackages: ["X"],
          id: "C/c.ts#Thing",
          package: "C",
          participation: { A: { references: 1 } },
        },
      ],
      edges: ["A→X", "X→C"],
    });
    const thing = concept(analysis, "C/c.ts#Thing");
    expect(thing.presence.packages).toEqual(["A", "C", "X"]);
    expect(thing.presence.roles.find((r) => r.package === "X")?.roles).toEqual(
      []
    );
    expect(thing.presence.behaviorPackages).toEqual([]);
    expect(thing.centers?.behavior).toBe("C");
    // The consumer's usage crosses into the aggregator; the aggregator's own
    // edge onward carries no role, so it never becomes a behavior boundary.
    expect(thing.topology.edges.map((e) => [e.id, e.roles.join(",")])).toEqual([
      ["A→X", "semantic-use"],
    ]);
    expect(thing.flow.semanticToUsage).toEqual([
      { distance: 2, package: "A", relation: "indirect", usageOnly: false },
    ]);
    expect(
      analysis.packageRoles.find((r) => r.package === "X")?.participating
    ).toMatchObject({ behaving: 0, total: 1, using: 0 });
    expect(
      analysis.boundaries.map((b) => [b.boundaryId, b.roles.behavior])
    ).toEqual([["A→X", 0]]);
  });
});

describe("history", () => {
  const analysis = analyze({
    concepts: [
      {
        couplings: [
          "core/memory-repo.ts|store/sql-repo.ts",
          "core/repo.test.ts|store/sql-repo.ts",
        ],
        hotspotModules: ["store/sql-repo.ts"],
        id: REPO,
        package: "core",
        participation: { store: { implementations: 1 } },
      },
    ],
    couplings: [
      { commits: 13, left: "store/sql-repo.ts", right: "core/memory-repo.ts" },
      {
        commits: 9,
        context: "source-test",
        left: "store/sql-repo.ts",
        right: "core/repo.test.ts",
      },
    ],
    edges: ["store→core"],
  });

  it("attaches source-source member couplings with both path kinds and keeps test pairs contextual", () => {
    const repo = concept(analysis, REPO);
    expect(repo.evolution?.strongMemberCouplings).toEqual([
      expect.objectContaining({
        coChangeCommits: 13,
        context: "source-source",
        dependencyPath: { forward: null, reverse: 1 },
        id: "core/memory-repo.ts|store/sql-repo.ts",
        scope: "cross-package",
        staticPath: "none",
      }),
    ]);
    expect(repo.evolution?.contextualCouplings.map((c) => c.context)).toEqual([
      "source-test",
    ]);
    expect(repo.evolution).toMatchObject({
      crossPackageCouplings: 1,
      historicallyActivePackages: ["core", "store"],
      hotspotPackages: ["store"],
    });
    expect(analysis.families[0]?.couplings).toEqual([
      "core/memory-repo.ts|store/sql-repo.ts",
    ]);
  });
});

describe("coverage", () => {
  it("leaves a foreign-only concept without centers, roles, or shapes", () => {
    const analysis = analyze({
      concepts: [
        { id: "A/a.ts#Thing", package: "A" },
        { foreign: true, id: "B/b.ts#Other", package: "B" },
      ],
      edges: ["A→B"],
      overlaps: [{ left: "A/a.ts#Thing", right: "B/b.ts#Other" }],
    });
    const other = concept(analysis, "B/b.ts#Other");
    expect(other.coverage).toBe("foreign-only");
    expect(other.centers).toBeUndefined();
    expect(other.shapes).toEqual([]);
    expect(other.propagation).toBe("unmeasured");
    expect(other.presence.roles).toEqual([
      { package: "B", roles: ["declares"] },
    ]);
    expect(other.cautions.map((c) => c.kind)).toEqual(["foreign-only"]);
    expect(analysis.directions).toEqual([]);
    expect(analysis.summary).toMatchObject({
      authoritative: 1,
      concepts: 2,
      foreignOnly: 1,
    });
    expect(analysis.cautions.map((c) => c.kind)).toEqual([
      "foreign-only-concepts",
    ]);
  });

  it("cautions under partial graph coverage and never claims a region split", () => {
    const analysis = analyze({
      concepts: [
        {
          id: "A/a.ts#Thing",
          package: "A",
          participation: { C: { implementations: 1 } },
        },
      ],
      missing: ["C"],
      packages: ["A", "C"],
    });
    const thing = concept(analysis, "A/a.ts#Thing");
    expect(thing.shapes).not.toContain("multi-region");
    expect(thing.topology.components).toEqual(["A", "C"]);
    expect(thing.cautions).toContainEqual(
      expect.objectContaining({
        entities: ["C"],
        kind: "partial-graph-coverage",
      })
    );
    expect(analysis.certainty).toBe("partial");
    expect(analysis.cautions[0]?.kind).toBe("partial-coverage");
  });

  it("keeps two concepts with the same display name apart everywhere", () => {
    const analysis = analyze({
      concepts: [
        {
          id: "A/a.ts#Status",
          package: "A",
          participation: { B: { references: 1 } },
        },
        {
          id: "B/b.ts#Status",
          package: "B",
          participation: { A: { references: 1 } },
        },
      ],
      edges: ["A→B", "B→A"],
    });
    expect(analysis.concepts.map((c) => c.concept.id)).toEqual([
      "A/a.ts#Status",
      "B/b.ts#Status",
    ]);
    expect(analysis.directions.map((d) => d.id)).toEqual([
      "A→B:semantic-to-usage",
      "B→A:semantic-to-usage",
    ]);
    expect(analysis.packageRoles.map((r) => r.declaredConcepts)).toEqual([
      1, 1,
    ]);
    const ws = workspace({ concepts: [], edges: ["A→B"] });
    expect(
      renderWorkspaceConcept(
        analyzeWorkspace(
          workspace({
            concepts: [
              { id: "A/a.ts#Status", package: "A" },
              { id: "B/b.ts#Status", package: "B" },
            ],
            edges: ["A→B"],
          })
        ),
        "Status"
      )
    ).toMatch(expectedTextPattern2);
    expect(renderWorkspaceConcept(analyzeWorkspace(ws), "Nope")).toBe(
      "no concept Nope"
    );
  });
});

describe("invariance and hygiene", () => {
  const spec: Spec = {
    concepts: [
      ...chain.concepts,
      { id: "core/other.ts#Other", package: "core" },
    ],
    couplings: [{ left: "store/sql-repo.ts", right: "core/memory-repo.ts" }],
    edges: ["app→store", "store→core", "app→core:0"],
    overlaps: [{ left: REPO, right: "core/other.ts#Other" }],
  };

  it("leaves everything but the review annotation unchanged when V8 reviews change", () => {
    const without = analyze(spec);
    const withReview = analyze({
      ...spec,
      reviews: [{ conceptId: REPO, disposition: "credible-alternative" }],
    });
    const strip = (analysis: WorkspaceConceptIntelligence) =>
      JSON.stringify({
        ...analysis,
        concepts: analysis.concepts.map(
          ({ architecture: _a, ...rest }) => rest
        ),
      });
    expect(strip(withReview)).toBe(strip(without));
    expect(concept(withReview, REPO).architecture?.reviewDisposition).toBe(
      "credible-alternative"
    );
    expect(
      concept(without, REPO).architecture?.reviewDisposition
    ).toBeUndefined();
  });

  it("is byte-stable under input reordering", () => {
    const forward = workspace(spec);
    const shuffled = workspace({
      ...spec,
      concepts: [...spec.concepts].reverse(),
      edges: [...(spec.edges ?? [])].reverse(),
    });
    shuffled.concepts.concepts.reverse();
    shuffled.concepts.overlaps.reverse();
    shuffled.graph.dependencyEdges.reverse();
    shuffled.evolution.couplings.reverse();
    const a = analyzeWorkspaceConcepts(forward, analyzeWorkspaceGraph(forward));
    const b = analyzeWorkspaceConcepts(
      shuffled,
      analyzeWorkspaceGraph(shuffled)
    );
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("carries no pattern label and no score", () => {
    const text = JSON.stringify(analyze(spec));
    expect(text).not.toMatch(expectedTextPattern);
  });

  it("stamps the workspace intelligence policy and renders one concept", () => {
    const report = analyzeWorkspace(workspace(spec));
    expect(report.intelligence?.policyVersion).toBe(
      WORKSPACE_INTELLIGENCE_POLICY_VERSION
    );
    expect(report.intelligence?.concepts?.summary.concepts).toBe(2);
    const focused = renderWorkspaceConcept(report, REPO);
    expect(focused).toContain(
      "store             implements, represents, uses, behaves"
    );
    expect(focused).toContain("implementation  store direct 1");
  });
});
