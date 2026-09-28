import { describe, expect, it } from "vitest";
import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import {
  createWorkspaceProjectionContext,
  projectWorkspaceBoundary,
  projectWorkspaceConcept,
  projectWorkspaceOverview,
  projectWorkspacePackage,
  projectWorkspacePattern,
  resolveWorkspaceEntity,
  searchWorkspace,
  summarizeWorkspaceConcept,
  summarizeWorkspacePackage,
  workspaceProjectionManifest,
} from "../../src/lib/workspace-projection";
import type { WorkspaceProjectionContext } from "../../src/lib/workspace-projection-types";
import { WORKSPACE_PROJECTION_SCHEMA_VERSION } from "../../src/lib/workspace-projection-types";
import {
  listConceptDirections,
  listWorkspaceReviews,
  projectConceptGraph,
  projectWorkspaceGraph,
  projectWorkspaceMatrix,
  queryWorkspace,
  rankWorkspace,
} from "../../src/lib/workspace-projection-views";
import { WORKSPACE_SCHEMA_VERSION } from "../../src/lib/workspace-types";
import type { ConceptSpec, Spec } from "./helpers/workspace-builder";
import { workspace } from "./helpers/workspace-builder";

const expectedTextPattern = /schema 4/;
const expectedTextPattern2 = /analyzeWorkspace/;
const expectedTextPattern3 = /"score"|hub|recommend/;
const expectedTextPattern4 = /"(x|y|color|width|height|font|weight)":/;
const expectedTextPattern5 = /"weight"|"strength":\s*\d/;
const expectedTextPattern6 = /should|recommend|move behavior|refactor/i;
const expectedTextPattern7 = /"center":/;

const STORE = "A/store.ts#ModuleStore";

/** `n` concepts declared in `pkg`, each implemented and behaved in `impl`. */
function implemented(pkg: string, impl: string, n: number): ConceptSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    behavior: { [impl]: { implementationBehaviors: 2, sourceBehaviors: 2 } },
    center: { implementations: [impl] },
    id: `${pkg}/c${i}.ts#${pkg}Thing${i}`,
    implementsCount: 1,
    package: pkg,
    participation: {
      [pkg]: { references: 1, representations: 1 },
      [impl]: { implementations: 1, references: 2 },
    },
  }));
}

/**
 * A declares contracts; X implements them (and imports A); U consumes A's
 * ModuleStore heavily over a high-volume edge. ModuleStore is the rich
 * concept: two implementation centers, a usage center elsewhere, a
 * source/test/story behavior split, one coupling, and a V8 review.
 */
function spec(extra: Partial<Spec> = {}): Spec {
  return {
    concepts: [
      ...implemented("A", "X", 2),
      ...implemented("B", "X", 1),
      {
        behavior: {
          A: { contractBehaviors: 1, sourceBehaviors: 1 },
          X: {
            implementationBehaviors: 3,
            sourceBehaviors: 3,
            storyBehaviors: 1,
            testBehaviors: 2,
          },
        },
        center: {
          behavior: "X",
          implementations: ["A", "X"],
          semantic: "A",
          usage: "U",
        },
        couplings: ["A/store.ts|X/store-impl.ts"],
        id: STORE,
        implementsCount: 2,
        package: "A",
        participation: {
          A: { implementations: 1, references: 1, representations: 1 },
          U: { references: 5 },
          X: { implementations: 1, references: 2 },
        },
      },
    ],
    couplings: [{ commits: 13, left: "A/store.ts", right: "X/store-impl.ts" }],
    edges: ["X→A", "X→B", "U→A:10", "U→X"],
    reviews: [
      {
        centers: ["X"],
        conceptId: STORE,
        disposition: "insufficient-evidence",
        unresolved: [
          {
            kind: "partial-simulation",
            uncertainties: ["composition-root-remains"],
            unmeasuredEdges: ["U→X"],
          },
        ],
      },
    ],
    ...extra,
  };
}

function context(overrides: Partial<Spec> = {}): WorkspaceProjectionContext {
  return createWorkspaceProjectionContext(
    analyzeWorkspace(workspace(spec(overrides)))
  );
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

describe("package projection", () => {
  it("combines graph facts, roles, directions, boundaries, patterns, and review context", () => {
    const ctx = context();
    const x = must(projectWorkspacePackage(ctx, "X"), "X");
    expect(x.graph).toMatchObject({ fanIn: 1, fanOut: 2 });
    expect(x.roles.map((r) => r.kind)).toEqual(["implementation-center"]);
    expect(x.roles[0]).toMatchObject({
      conceptCount: 4,
      coverage: "complete",
      patternId: "role:implementation-center:X",
      sourcePackages: ["A", "B"],
    });
    expect(x.concepts.foreign.implemented).toBe(4);
    expect(
      x.incomingDirections.map((d) => `${d.from}→${d.to}:${d.role}`)
    ).toEqual(
      expect.arrayContaining(["A→X:implementation", "B→X:implementation"])
    );
    expect(x.outgoingDirections).toEqual([]);
    expect(x.boundaries.map((b) => `${b.direction} ${b.boundaryId}`)).toEqual([
      "incoming U→X",
      "outgoing X→A",
      "outgoing X→B",
    ]);
    expect(x.patterns).toContain("role:implementation-center:X");
    expect(x.reviews.asGravityCenter?.reviewed).toBe(1);
    expect(x.reviews.directions).toMatchObject([
      { from: "A", reviews: { reviewed: 1 }, to: "X" },
    ]);
    expect(x.coverage).toMatchObject({
      certainty: "complete",
      missingPackages: [],
    });
    expect(x.cautions).toEqual([]);
  });

  it("keeps the semantic direction apart from the static dependency direction", () => {
    const ctx = context();
    const direction = must(
      projectWorkspacePackage(ctx, "X"),
      "X"
    ).incomingDirections.find(
      (d) => d.from === "A" && d.role === "implementation"
    );
    expect(direction).toMatchObject({
      dependencyPath: { forward: null, reverse: 1 },
      from: "A",
      staticDependencyDirection: "reverse",
      to: "X",
    });
    const graph = projectWorkspaceGraph(ctx, "architecture-overview");
    const dependency = graph.edges.find((e) => e.id === "X→A");
    const semantic = graph.edges.find(
      (e) =>
        e.kind === "direction" &&
        e.from === "A" &&
        e.to === "X" &&
        e.role === "implementation"
    );
    expect(dependency).toMatchObject({
      from: "X",
      kind: "dependency",
      to: "A",
    });
    expect(semantic).toMatchObject({
      from: "A",
      kind: "direction",
      staticDependencyDirection: "reverse",
      to: "X",
    });
  });

  it("adds evidence refs only in evidence detail and never contradicts the summary", () => {
    const ctx = context();
    const standard = must(projectWorkspacePackage(ctx, "X"), "X");
    const evidence = must(projectWorkspacePackage(ctx, "X", "evidence"), "X");
    expect(standard.evidenceRefs).toBeUndefined();
    expect(evidence.evidenceRefs?.some((r) => r.source === "pattern")).toBe(
      true
    );
    const { evidenceRefs: _refs, ...rest } = evidence;
    expect(rest).toEqual(standard);
    const summary = summarizeWorkspacePackage(standard);
    expect(summary.roles).toEqual([
      {
        conceptCount: 4,
        kind: "implementation-center",
        strength: standard.roles[0]?.strength,
      },
    ]);
    expect(summary.directions.incoming).toBe(
      standard.incomingDirections.length
    );
    expect(summary.reviewed).toBe(1);
  });
});

describe("concept projection", () => {
  it("carries the whole ModuleStore story: centers, participation, split, history, review", () => {
    const ctx = context();
    const store = must(projectWorkspaceConcept(ctx, STORE), "store");
    expect(store.centers).toMatchObject({
      behavior: "X",
      implementations: ["A", "X"],
      semantic: "A",
      usage: "U",
    });
    expect(store.presence).toMatchObject({
      behaviorPackages: ["X"],
      contractBehaviorPackages: ["A"],
      declaredPackage: "A",
      implementationPackages: ["A", "X"],
      referencePackages: ["A", "U", "X"],
    });
    const x = must(
      store.participation.find((p) => p.package === "X"),
      "X row"
    );
    expect(x.roles).toEqual(
      expect.arrayContaining(["implements", "behaves", "uses"])
    );
    expect(x).toMatchObject({
      implementationBehaviors: 3,
      implementations: 1,
      references: 2,
      representations: 0,
      sourceBehaviors: 3,
      storyBehaviors: 1,
      testBehaviors: 2,
    });
    expect(store.locality?.behavior).toEqual({
      contract: 1,
      conversion: 0,
      implementation: 3,
      source: 4,
      story: 1,
      test: 2,
    });
    expect(store.distribution?.representations).toEqual({
      count: 1,
      package: "A",
      share: 1,
      total: 1,
    });
    expect(store.evolution).toMatchObject({
      coChangeCommits: 13,
      strongMemberCouplings: [
        expect.objectContaining({
          coChangeCommits: 13,
          id: "A/store.ts|X/store-impl.ts",
          scope: "cross-package",
        }),
      ],
    });
    expect(store.recentering).toMatchObject({
      finding: {
        id: STORE,
        observedCenters: [
          { gravity: 1, target: "X" },
          { gravity: 0.8, target: "A" },
        ],
      },
      review: {
        baselineDominated: false,
        disposition: "insufficient-evidence",
        gravityCenter: "X",
        unresolved: [
          {
            kind: "partial-simulation",
            scenarioIds: [`${STORE}::preserve-current`],
          },
        ],
      },
      status: "candidate",
    });
    expect(
      store.recentering?.scenarios.find((s) => s.kind === "preserve-current")
        ?.impact
    ).toMatchObject({
      status: "partially-simulated",
      uncertainties: ["composition-root-remains"],
      unmeasuredEdges: ["U→X"],
    });
    expect(store.patterns).toContain("role:implementation-center:X");
  });

  it("never flattens distinct centers into one", () => {
    const ctx = context();
    const store = must(projectWorkspaceConcept(ctx, STORE), "store");
    const text = JSON.stringify(store);
    expect(text).not.toMatch(expectedTextPattern7);
    expect(store.centers?.semantic).not.toBe(store.centers?.usage);
    expect(store.centers?.usage).not.toBe(store.centers?.behavior);
    const summary = summarizeWorkspaceConcept(store);
    expect(summary.centers).toEqual({
      behavior: "X",
      implementations: ["A", "X"],
      semantic: "A",
      usage: "U",
    });
    expect(summary.reviewDisposition).toBe("insufficient-evidence");
  });

  it("keeps V8 uncertainty verbatim and never words it as advice", () => {
    const ctx = context();
    const store = must(
      projectWorkspaceConcept(ctx, STORE, "evidence"),
      "store"
    );
    expect(store.recentering?.review?.disposition).toBe(
      "insufficient-evidence"
    );
    expect(JSON.stringify(store)).not.toMatch(expectedTextPattern6);
    expect(store.evidenceRefs).toEqual(
      expect.arrayContaining([
        {
          entityIds: [STORE],
          kind: "review",
          source: "v8-review",
          value: "insufficient-evidence",
        },
      ])
    );
  });

  it("stays compact: ids and counts, no embedded canonical models", () => {
    const ctx = context();
    const store = must(
      projectWorkspaceConcept(ctx, STORE, "evidence"),
      "store"
    );
    const text = JSON.stringify(store);
    expect(text).not.toContain("observedBy");
    expect(text).not.toContain("provenance");
    expect(text.length).toBeLessThan(12_000);
  });
});

describe("boundary projection", () => {
  it("keeps volume, diversity, role counts, structure, and patterns independent", () => {
    const ctx = context();
    const xa = must(projectWorkspaceBoundary(ctx, "X→A"), "X→A");
    const ua = must(projectWorkspaceBoundary(ctx, "U→A"), "U→A");
    expect(xa.volume).toMatchObject({
      importSites: 2,
      moduleEdges: 1,
      references: 5,
    });
    expect(xa.concepts).toMatchObject({
      behavior: 3,
      implementation: 3,
      semanticUse: 3,
      total: 3,
    });
    expect(xa.ratios.conceptsPerImportSite).toEqual({
      concepts: 3,
      importSites: 2,
      value: 1.5,
    });
    expect(ua.volume).toMatchObject({ importSites: 20, moduleEdges: 10 });
    expect(ua.concepts).toMatchObject({
      implementation: 0,
      semanticUse: 1,
      total: 1,
    });
    expect(ua.ratios.conceptsPerImportSite).toEqual({
      concepts: 1,
      importSites: 20,
      value: 0.05,
    });
    expect(xa.structure.inPackageGraph).toBe(true);
    expect(typeof xa.structure.severedPairs).toBe("number");
    expect(xa.patterns).toMatchObject({
      kinds: ctx.patterns.boundaries.find((b) => b.boundaryId === "X→A")?.kinds,
      patternId: "boundary:X→A",
    });
    expect(ua.patterns.kinds).toEqual([]);
    expect(xa.cautions).toEqual([]);
    expect(JSON.stringify(xa)).not.toMatch(expectedTextPattern5);
  });
});

describe("graph projections", () => {
  it("emits canonical ids with no layout or style fields", () => {
    const ctx = context();
    const graph = projectWorkspaceGraph(ctx, "dependency-topology");
    expect(graph.nodes.map((n) => n.id)).toEqual(["A", "B", "U", "X"]);
    expect(graph.edges.map((e) => e.id)).toEqual(["U→A", "U→X", "X→A", "X→B"]);
    expect(graph.edges.every((e) => e.kind === "dependency")).toBe(true);
    expect(graph.groups.some((g) => g.kind === "layer")).toBe(true);
    expect(JSON.stringify(graph)).not.toMatch(expectedTextPattern4);
    expect(graph.metadata).toMatchObject({
      preset: "dependency-topology",
      scope: "workspace",
    });
  });

  it("selects semantic direction edges per flow preset and filters deterministically", () => {
    const ctx = context();
    const flow = projectWorkspaceGraph(ctx, "implementation-flow", {
      connectedOnly: true,
    });
    expect(flow.nodes.map((n) => n.id)).toEqual(["A", "B", "X"]);
    expect(flow.edges.map((e) => `${e.from}→${e.to}`)).toEqual(["A→X", "B→X"]);
    const filtered = projectWorkspaceGraph(ctx, "implementation-flow", {
      minConcepts: 2,
    });
    expect(filtered.edges.map((e) => `${e.from}→${e.to}`)).toEqual(["A→X"]);
    const review = projectWorkspaceGraph(ctx, "architecture-review");
    expect(review.edges).toEqual([
      expect.objectContaining({ from: "A", kind: "review", to: "X" }),
    ]);
  });

  it("focuses the concept graph on one concept without a workspace explosion", () => {
    const ctx = context();
    const graph = must(projectConceptGraph(ctx, STORE), "graph");
    expect(graph.nodes.map((n) => `${n.kind}:${n.id}`)).toEqual([
      `concept:${STORE}`,
      "package:A",
      "package:U",
      "package:X",
    ]);
    expect(graph.edges.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        "declared-in",
        "implemented-in",
        "behavior-in",
        "used-in",
        "dependency",
      ])
    );
    expect(graph.nodes.filter((n) => n.kind === "concept")).toHaveLength(1);
  });
});

describe("matrix and ranked projections", () => {
  it("builds sparse role, direction, boundary, and review matrices with exact cells", () => {
    const ctx = context();
    const roles = projectWorkspaceMatrix(ctx, {
      kind: "package-concept-roles",
    });
    expect(roles.cells).toEqual(
      expect.arrayContaining([
        { column: "declared", row: "A", value: 3 },
        { column: "implementing", row: "X", value: 4 },
        { column: "using", row: "U", value: 1 },
      ])
    );
    const direction = projectWorkspaceMatrix(ctx, {
      kind: "package-direction",
      metric: "implementation",
    });
    expect(direction.cells).toMatchObject([
      { column: "X", row: "A", value: 3 },
      { column: "X", entityIds: ["B/c0.ts#BThing0"], row: "B", value: 1 },
    ]);
    expect(direction.cells[0]?.entityIds).toContain(STORE);
    const load = projectWorkspaceMatrix(ctx, {
      kind: "boundary-concept-load",
      metric: "importSites",
    });
    expect(load.cells).toEqual([
      { column: "A", row: "U", value: 20 },
      { column: "X", row: "U", value: 2 },
      { column: "A", row: "X", value: 2 },
      { column: "B", row: "X", value: 2 },
    ]);
    const review = projectWorkspaceMatrix(ctx, {
      kind: "review",
      metric: "reviewed",
    });
    expect(review.cells).toEqual([
      { column: "X", entityIds: [STORE], row: "A", value: 1 },
    ]);
  });

  it("ranks on one explicit metric and keeps ratio numerators and denominators", () => {
    const ctx = context();
    const ratio = rankWorkspace(ctx, {
      kind: "boundaries",
      metric: "conceptsPerImportSite",
    });
    expect(ratio.entries[0]).toMatchObject({
      denominator: 2,
      id: "X→A",
      numerator: 3,
      value: 1.5,
    });
    expect(ratio.sort).toBe("value desc, id asc");
    const packages = rankWorkspace(ctx, {
      kind: "packages",
      limit: 1,
      metric: "foreignImplemented",
    });
    expect(packages.entries).toEqual([
      { id: "X", kind: "package", label: "X", value: 4 },
    ]);
    expect(packages.total).toBe(1);
  });

  it("lists directions and reviews under explicit filters and sorts", () => {
    const ctx = context();
    const directions = listConceptDirections(ctx, {
      minCount: 2,
      role: "implementation",
      to: "X",
    });
    expect(directions.directions.map((d) => d.id)).toEqual([
      "A→X:semantic-to-implementation",
    ]);
    expect(directions.directions[0]?.concepts).toHaveLength(3);
    const reviews = listWorkspaceReviews(ctx, {
      disposition: "insufficient-evidence",
    });
    expect(reviews.reviews.map((r) => r.conceptId)).toEqual([STORE]);
    expect(
      listWorkspaceReviews(ctx, { baselineDominated: true }).reviews
    ).toEqual([]);
  });
});

describe("queries, search, and resolution", () => {
  it("returns every candidate for an ambiguous name and never picks one", () => {
    const ctx = context({
      concepts: [
        ...spec().concepts,
        { id: "A/status.ts#Status", package: "A" },
        { id: "X/status.ts#Status", package: "X" },
      ],
    });
    const resolution = resolveWorkspaceEntity(ctx, "Status", "concept");
    expect(resolution.status).toBe("ambiguous");
    const result = queryWorkspace(ctx, { id: "Status", kind: "concept" });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((c) => c.id)).toEqual([
        "A/status.ts#Status",
        "X/status.ts#Status",
      ]);
    }
    expect(
      queryWorkspace(ctx, { id: "A/status.ts#Status", kind: "concept" }).kind
    ).toBe("concept");
    expect(queryWorkspace(ctx, { id: "Nope", kind: "concept" }).kind).toBe(
      "not-found"
    );
  });

  it("searches deterministically by id, name, or alias", () => {
    const ctx = context();
    expect(searchWorkspace(ctx, "store").matches.map((m) => m.id)).toEqual([
      STORE,
      STORE,
    ]);
    expect(
      searchWorkspace(ctx, "store", { kinds: ["concept"] }).matches.map(
        (m) => m.kind
      )
    ).toEqual(["concept"]);
    expect(
      searchWorkspace(ctx, "X→A", {
        kinds: ["boundary"],
        mode: "exact",
      }).matches.map((m) => m.id)
    ).toEqual(["X→A"]);
    expect(queryWorkspace(ctx, { id: "X->A", kind: "boundary" }).kind).toBe(
      "boundary"
    );
  });

  it("dispatches summary detail through the same projection", () => {
    const ctx = context();
    const summary = queryWorkspace(ctx, {
      detail: "summary",
      id: "X",
      kind: "package",
    });
    expect(summary.kind).toBe("package-summary");
    const pattern = queryWorkspace(ctx, {
      id: "role:implementation-center:X",
      kind: "pattern",
    });
    expect(pattern.kind).toBe("pattern");
    if (pattern.kind === "pattern") {
      expect(pattern.result.insight.support.count).toBe(4);
      expect(pattern.result.insight.support.entityIds).toContain(STORE);
      expect(pattern.result.structure).toMatchObject({
        package: "X",
        role: "implementation-center",
      });
    }
    expect(workspaceProjectionManifest(ctx)).toMatchObject({
      projectionSchemaVersion: WORKSPACE_PROJECTION_SCHEMA_VERSION,
      workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
    });
  });
});

describe("coverage, determinism, and non-inference", () => {
  it("propagates partial coverage into every top-level projection", () => {
    const ctx = context({
      edges: [...(spec().edges ?? []), "M→A"],
      missing: ["M"],
    });
    expect(projectWorkspaceOverview(ctx).coverage).toMatchObject({
      certainty: "partial",
      missingPackages: ["M"],
    });
    expect(projectWorkspacePackage(ctx, "X")?.coverage.certainty).toBe(
      "partial"
    );
    expect(
      projectWorkspaceGraph(ctx, "dependency-topology").metadata.coverage
        .certainty
    ).toBe("partial");
    expect(
      projectWorkspaceBoundary(ctx, "M→A")?.cautions.map((c) => c.kind)
    ).toContain("partial-coverage");
    expect(
      projectWorkspacePackage(ctx, "M")?.cautions.map((c) => c.kind)
    ).toContain("package-not-analyzed");
    expect(
      projectWorkspaceOverview(ctx).limitations.map((l) => l.kind)
    ).toContain("partial-package-coverage");
  });

  it("is invariant under input reordering", () => {
    const base = spec();
    const shuffled: Spec = {
      ...base,
      concepts: [...base.concepts].reverse(),
      edges: [...(base.edges ?? [])].reverse(),
    };
    const a = context();
    const b = createWorkspaceProjectionContext(
      analyzeWorkspace(workspace(shuffled))
    );
    expect(JSON.stringify(projectWorkspaceOverview(a))).toBe(
      JSON.stringify(projectWorkspaceOverview(b))
    );
    expect(JSON.stringify(projectWorkspacePackage(a, "X"))).toBe(
      JSON.stringify(projectWorkspacePackage(b, "X"))
    );
    expect(JSON.stringify(projectWorkspaceConcept(a, STORE))).toBe(
      JSON.stringify(projectWorkspaceConcept(b, STORE))
    );
    expect(
      JSON.stringify(projectWorkspaceGraph(a, "architecture-overview"))
    ).toBe(JSON.stringify(projectWorkspaceGraph(b, "architecture-overview")));
    expect(
      JSON.stringify(
        projectWorkspaceMatrix(a, { kind: "package-concept-roles" })
      )
    ).toBe(
      JSON.stringify(
        projectWorkspaceMatrix(b, { kind: "package-concept-roles" })
      )
    );
  });

  it("mirrors V9.3 patterns exactly and adds none", () => {
    const ctx = context();
    const v93 = ctx.patterns;
    const overview = projectWorkspaceOverview(ctx);
    expect(overview.architecture.packageRoles).toHaveLength(
      v93.summary.packageRoles
    );
    expect(overview.architecture.conceptPatterns).toHaveLength(
      v93.conceptPatterns.length
    );
    expect(ctx.index.patterns).toHaveLength(
      v93.summary.packageRoles +
        v93.packagePairs.filter((p) => p.patterns.length > 0).length +
        v93.boundaries.filter((b) => b.kinds.length > 0).length +
        v93.conceptPatterns.length +
        v93.evolutionaryPatterns.length
    );
    for (const profile of v93.packages) {
      const projected = must(
        projectWorkspacePackage(ctx, profile.package),
        profile.package
      );
      expect(projected.roles.map((r) => r.kind)).toEqual(
        profile.roles.map((r) => r.kind)
      );
    }
    for (const entry of ctx.index.patterns) {
      expect(projectWorkspacePattern(ctx, entry.id)?.kinds).toEqual(
        entry.kinds
      );
    }
    expect(JSON.stringify(overview)).not.toMatch(expectedTextPattern3);
  });

  it("refuses a workspace without attached intelligence or from another schema", () => {
    expect(() => createWorkspaceProjectionContext(workspace(spec()))).toThrow(
      expectedTextPattern2
    );
    const stale = {
      ...analyzeWorkspace(workspace(spec())),
      workspaceSchemaVersion: 4,
    };
    expect(() => createWorkspaceProjectionContext(stale)).toThrow(
      expectedTextPattern
    );
  });
});
