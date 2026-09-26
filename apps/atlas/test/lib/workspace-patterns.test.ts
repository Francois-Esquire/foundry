import { describe, expect, it } from "vitest";
import { analyzeWorkspaceConcepts } from "../../src/lib/workspace-concepts";
import { analyzeWorkspaceGraph } from "../../src/lib/workspace-graph";

import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import { analyzeWorkspacePatterns } from "../../src/lib/workspace-patterns";
import type { WorkspaceArchitecturalPatterns } from "../../src/lib/workspace-patterns-types";
import type {
  ConceptSpec,
  ReviewSpec,
  Spec,
} from "./helpers/workspace-builder";
import { workspace } from "./helpers/workspace-builder";

function analyze(spec: Spec): WorkspaceArchitecturalPatterns {
  const ws = workspace(spec);
  const graph = analyzeWorkspaceGraph(ws);
  return analyzeWorkspacePatterns(
    ws,
    graph,
    analyzeWorkspaceConcepts(ws, graph)
  );
}

function rolesOf(patterns: WorkspaceArchitecturalPatterns, pkg: string) {
  return patterns.packages.find((p) => p.package === pkg)?.roles ?? [];
}

function pairOf(patterns: WorkspaceArchitecturalPatterns, id: string) {
  const found = patterns.packagePairs.find((p) => p.id === id);
  if (found === undefined) {
    throw new Error(`no pair ${id}`);
  }
  return found;
}

/** `n` concepts declared in `pkg`, each implemented (and behaved) in `impl`. */
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

/** `n` concepts declared in `pkg` and merely used by `user`. */
function used(pkg: string, user: string, n: number): ConceptSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${pkg}/u${i}.ts#${pkg}Used${i}`,
    package: pkg,
    participation: { [user]: { references: 1 } },
  }));
}

describe("package roles", () => {
  it("names an implementation center from three concepts of three semantic packages", () => {
    const patterns = analyze({
      concepts: [
        ...implemented("A", "X", 1),
        ...implemented("B", "X", 1),
        ...implemented("C", "X", 1),
      ],
      edges: ["X→A", "X→B", "X→C"],
    });
    const role = rolesOf(patterns, "X").find(
      (r) => r.kind === "implementation-center"
    );
    expect(role).toMatchObject({
      coverage: "complete",
      sourcePackages: ["A", "B", "C"],
      support: { conceptCount: 3 },
    });
    expect(role?.support.observations.map((o) => o.source)).toEqual(
      expect.arrayContaining(["workspace-concepts", "boundary"])
    );
    expect(patterns.statements.map((s) => s.kind)).toContain(
      "downstream-implementation-convergence"
    );
  });

  it("does not turn one implemented concept into a workspace role", () => {
    const patterns = analyze({
      concepts: implemented("A", "X", 1),
      edges: ["X→A"],
    });
    expect(rolesOf(patterns, "X")).toEqual([]);
    expect(
      patterns.packages.find((p) => p.package === "X")?.counts
    ).toMatchObject({ foreignImplemented: 1, foreignSources: 1 });
    expect(
      patterns.thresholds.find(
        (t) => t.name === "roles.implementation-center.minConcepts"
      )?.counts
    ).toEqual({ above: 0, at: 0, below: 0 });
  });

  it("names representation and conversion centers from converter evidence, not names", () => {
    const pairs = [
      ["A", "Alpha", "Kappa"],
      ["A", "Beta", "Lambda"],
      ["B", "Gamma", "Mu"],
    ] as const;
    const patterns = analyze({
      concepts: pairs.flatMap(([pkg, name, mirror]) => [
        {
          id: `${pkg}/${name}.ts#${name}`,
          package: pkg,
          participation: { X: { references: 1, representations: 1 } },
        },
        { id: `X/${mirror}.ts#${mirror}`, package: "X" },
      ]),
      edges: ["X→A", "X→B"],
      overlaps: pairs.map(([pkg, name, mirror]) => ({
        conversions: [
          `to${mirror}@X/convert.ts:${pkg}/${name}.ts#${name}>X/${mirror}.ts#${mirror}`,
        ],
        left: `${pkg}/${name}.ts#${name}`,
        right: `X/${mirror}.ts#${mirror}`,
      })),
    });
    expect(rolesOf(patterns, "X").map((r) => r.kind)).toEqual([
      "representation-center",
      "conversion-center",
    ]);
    expect(rolesOf(patterns, "X")[0]?.sourcePackages).toEqual(["A", "B"]);
    expect(JSON.stringify(patterns)).not.toMatch(/Row|Record|persistence/);
  });

  it("names a consumption center without semantic ownership", () => {
    const patterns = analyze({
      concepts: [
        ...used("A", "X", 4),
        ...used("B", "X", 3),
        ...used("C", "X", 3),
      ],
      edges: ["X→A", "X→B", "X→C"],
    });
    expect(rolesOf(patterns, "X").map((r) => r.kind)).toEqual([
      "consumption-center",
    ]);
    expect(rolesOf(patterns, "A")).toEqual([]);
    expect(
      patterns.packages.find((p) => p.package === "X")?.counts
    ).toMatchObject({
      declared: 0,
      declaredCrossPackage: 0,
      foreignSources: 3,
      foreignUsed: 10,
    });
  });

  it("names a semantic center only when its concepts flow to several packages", () => {
    const patterns = analyze({
      concepts: [
        ...used("A", "X", 2),
        ...used("A", "Y", 2),
        ...used("B", "Z", 3),
      ],
      edges: ["X→A", "Y→A", "Z→B"],
    });
    expect(rolesOf(patterns, "A").map((r) => r.kind)).toEqual([
      "semantic-center",
    ]);
    expect(rolesOf(patterns, "B")).toEqual([]);
  });

  it("never emits integration-center from fan-out; corroboration only surfaces the wiring gap", () => {
    const fanOut = analyze({
      concepts: [{ id: "A/a.ts#Thing", package: "A" }],
      edges: ["X→A", "X→B", "X→C", "X→D"],
      profiles: { X: ["integration-like"] },
    });
    expect(rolesOf(fanOut, "X")).toEqual([]);
    expect(fanOut.coveragePatterns.map((c) => c.kind)).not.toContain(
      "composition-root-gap"
    );
    const corroborated = analyze({
      concepts: [
        ...used("A", "X", 4),
        ...used("B", "X", 3),
        ...used("C", "X", 3),
      ],
      edges: ["X→A", "X→B", "X→C", "X→D"],
      profiles: { X: ["integration-like"] },
    });
    expect(rolesOf(corroborated, "X").map((r) => r.kind)).toEqual([
      "consumption-center",
    ]);
    expect(corroborated.coveragePatterns).toContainEqual(
      expect.objectContaining({
        entities: ["X"],
        kind: "composition-root-gap",
      })
    );
    expect(corroborated.cautions.map((c) => c.kind)).toContain(
      "no-wiring-evidence"
    );
  });
});

describe("direction patterns", () => {
  const split: Spec = {
    concepts: implemented("A", "B", 3),
    edges: ["B→A"],
  };
  const review = (
    disposition: string,
    extra: Partial<ReviewSpec> = {}
  ): ReviewSpec[] =>
    split.concepts.map((c) => ({
      centers: ["B"],
      conceptId: c.id,
      disposition,
      ...extra,
    }));

  it("reads a repeated direction with preserve-current reviews as a stable split", () => {
    const patterns = analyze({
      ...split,
      reviews: review("preserve-current"),
    });
    const pair = pairOf(patterns, "A→B");
    expect(pair.patterns).toEqual([
      "implementation-channel",
      "repeated-consumption",
      "stable-responsibility-split",
    ]);
    expect(pair.reviews).toMatchObject({
      dominatedBaselines: [],
      preserved: split.concepts.map((c) => c.id),
      reviewed: 3,
    });
    expect(pair.graph).toMatchObject({
      directEdge: "B→A",
      forward: null,
      reverse: 1,
    });
  });

  it("reads dominated baselines that re-home behavior as repeated externalization", () => {
    const patterns = analyze({
      ...split,
      reviews: review("credible-alternative", {
        dominatedBy: "rehome-behavior",
      }),
    });
    expect(pairOf(patterns, "A→B").patterns).toContain(
      "repeated-externalization"
    );
    const concept = patterns.conceptPatterns.find(
      (c) => c.kind === "repeated-behavior-externalization"
    );
    expect(concept).toMatchObject({
      structure: { gravityCenter: "B", semanticPackages: ["A"] },
      support: { conceptCount: 3 },
    });
    expect(
      patterns.reviewPatterns.find((r) => r.scope === "gravity-center")
    ).toMatchObject({
      id: "B",
      reviews: { dominatingKinds: { "rehome-behavior": 3 } },
    });
    expect(patterns.statements.map((s) => s.kind)).toContain(
      "review-tension-concentration"
    );
  });

  it("reads disagreeing reviews as mixed, never as one conclusion", () => {
    const [first, second, third] = split.concepts.map((c) => c.id);
    const patterns = analyze({
      ...split,
      reviews: [
        {
          centers: ["B"],
          conceptId: first ?? "",
          disposition: "preserve-current",
        },
        {
          centers: ["B"],
          conceptId: second ?? "",
          disposition: "credible-alternative",
          dominatedBy: "rehome-behavior",
        },
        {
          centers: ["B"],
          conceptId: third ?? "",
          disposition: "insufficient-evidence",
        },
      ],
    });
    const pair = pairOf(patterns, "A→B");
    expect(pair.patterns).toContain("mixed");
    expect(pair.patterns).not.toContain("repeated-externalization");
    expect(pair.patterns).not.toContain("stable-responsibility-split");
  });

  it("ignores reviews that contest a different package", () => {
    const patterns = analyze({
      ...split,
      edges: ["B→A", "C→A"],
      reviews: review("credible-alternative", {
        centers: ["C"],
        dominatedBy: "rehome-behavior",
      }),
    });
    expect(pairOf(patterns, "A→B").reviews).toBeUndefined();
    expect(pairOf(patterns, "A→B").patterns).toEqual([
      "implementation-channel",
      "repeated-consumption",
    ]);
  });
});

describe("boundary patterns", () => {
  it("names an implementation channel from repeated implementation crossings", () => {
    const patterns = analyze({
      concepts: implemented("A", "B", 3),
      edges: ["B→A"],
    });
    expect(patterns.boundaries).toHaveLength(1);
    expect(patterns.boundaries[0]).toMatchObject({
      boundaryId: "B→A",
      conceptLoad: 3,
      kinds: ["implementation-channel"],
      roleLoad: { behavior: 3, implementation: 3 },
    });
  });

  it("keeps a high-volume boundary with unrelated usage free of role channels", () => {
    const patterns = analyze({
      concepts: used("A", "B", 2),
      edges: ["B→A:60"],
    });
    expect(patterns.boundaries[0]).toMatchObject({
      graph: { importSites: 120 },
      kinds: ["high-volume-channel"],
    });
    expect(pairOf(patterns, "A→B").patterns).toEqual([]);
  });

  it("annotates a low-volume boundary with high severance as a structural seam", () => {
    const patterns = analyze({
      concepts: used("B", "A", 1),
      edges: ["A→B", "B→C", "C→D"],
    });
    const seam = patterns.boundaries.find((b) => b.boundaryId === "A→B");
    expect(seam).toMatchObject({
      graph: { importSites: 2, seam: true, severedPairs: 2 },
      kinds: ["structural-seam"],
      strength: "limited",
    });
  });

  it("reads repeated source-source couplings across a loaded boundary as reinforcement", () => {
    const concepts = implemented("A", "B", 3).map((c, i) => ({
      ...c,
      couplings: [`A/c${i}.ts|B/impl${i}.ts`],
    }));
    const patterns = analyze({
      concepts,
      couplings: concepts.map((_, i) => ({
        left: `A/c${i}.ts`,
        right: `B/impl${i}.ts`,
      })),
      edges: ["B→A"],
    });
    expect(patterns.boundaries[0]?.kinds).toEqual([
      "implementation-channel",
      "historically-reinforced",
    ]);
    expect(patterns.evolutionaryPatterns).toEqual([
      expect.objectContaining({
        couplings: [
          "A/c0.ts|B/impl0.ts",
          "A/c1.ts|B/impl1.ts",
          "A/c2.ts|B/impl2.ts",
        ],
        id: "A|B",
        kinds: [
          "repeated-cross-boundary-change",
          "implementation-cochange",
          "static-temporal-alignment",
        ],
      }),
    ]);
  });

  it("does not let coupling alone create a concept pattern", () => {
    const patterns = analyze({
      concepts: [
        {
          couplings: ["A/a.ts|B/x.ts", "A/a.ts|B/y.ts", "A/a.ts|B/z.ts"],
          id: "A/a.ts#Thing",
          package: "A",
        },
      ],
      couplings: ["x", "y", "z"].map((f) => ({
        left: "A/a.ts",
        right: `B/${f}.ts`,
      })),
      edges: ["B→A"],
    });
    expect(patterns.evolutionaryPatterns[0]?.kinds).toEqual([
      "repeated-cross-boundary-change",
    ]);
    expect(patterns.boundaries).toEqual([]);
    expect(patterns.packagePairs).toEqual([]);
    expect(patterns.conceptPatterns).toEqual([]);
  });
});

describe("concept patterns", () => {
  it("names parallel contract implementations from repeated family structure", () => {
    const families = ["Alpha", "Beta", "Gamma"].map((name, i) => ({
      behavior: {
        [`P${i}`]: { implementationBehaviors: 1, sourceBehaviors: 1 },
        X: { implementationBehaviors: 1, sourceBehaviors: 1 },
      },
      center: { implementations: [`P${i}`, "X"] },
      id: `P${i}/${name}.ts#${name}`,
      implementsCount: 2,
      package: `P${i}`,
      participation: {
        [`P${i}`]: { implementations: 1, references: 1 },
        X: { implementations: 1, references: 1 },
      },
    }));
    const patterns = analyze({
      concepts: families,
      edges: ["X→P0", "X→P1", "X→P2"],
    });
    expect(patterns.conceptPatterns).toContainEqual(
      expect.objectContaining({
        coverage: "complete",
        kind: "parallel-contract-implementations",
        structure: {
          contractPackages: ["P0", "P1", "P2"],
          externalImplementationPackages: ["X"],
          families: 3,
          localImplementation: true,
        },
      })
    );
    expect(patterns.statements.map((s) => s.kind)).toContain(
      "parallel-implementation-motif"
    );
  });

  it("names a conversion projection only with distinct concepts on both sides", () => {
    const projection = analyze({
      concepts: ["One", "Two", "Three"].flatMap((name) => [
        { id: `A/${name}.ts#${name}`, package: "A" },
        { id: `B/${name}Mirror.ts#${name}Mirror`, package: "B" },
      ]),
      edges: ["B→A"],
      overlaps: ["One", "Two", "Three"].map((name) => ({
        conversions: [
          `to@B/convert.ts:A/${name}.ts#${name}>B/${name}Mirror.ts#${name}Mirror`,
        ],
        left: `A/${name}.ts#${name}`,
        right: `B/${name}Mirror.ts#${name}Mirror`,
      })),
    });
    expect(
      projection.conceptPatterns.find(
        (c) => c.kind === "cross-package-conversion-projection"
      )
    ).toMatchObject({
      structure: {
        converterPackages: ["B"],
        leftConcepts: 3,
        packages: ["A", "B"],
        pairs: 3,
        rightConcepts: 3,
      },
    });
    const fan = analyze({
      concepts: [
        { id: "A/Hub.ts#Hub", package: "A" },
        ...["One", "Two", "Three"].map((name) => ({
          id: `B/${name}.ts#${name}`,
          package: "B",
        })),
      ],
      edges: ["B→A"],
      overlaps: ["One", "Two", "Three"].map((name) => ({
        conversions: [`to@B/convert.ts:A/Hub.ts#Hub>B/${name}.ts#${name}`],
        left: "A/Hub.ts#Hub",
        right: `B/${name}.ts#${name}`,
      })),
    });
    expect(fan.conceptPatterns).toEqual([]);
  });

  it("names shared semantic primitives from behavior-light upward use", () => {
    const patterns = analyze({
      concepts: ["Id", "Kind", "Stamp"].map((name) => ({
        id: `core/${name}.ts#${name}`,
        package: "core",
        participation: {
          app: { references: 1 },
          plug: { references: 1 },
          store: { references: 1 },
        },
      })),
      edges: ["app→core", "store→core", "plug→core"],
    });
    expect(patterns.conceptPatterns).toContainEqual(
      expect.objectContaining({
        kind: "shared-semantic-primitive",
        structure: {
          consumerPackages: ["app", "plug", "store"],
          declaredPackage: "core",
          layer: 0,
        },
      })
    );
    expect(patterns.statements[0]).toMatchObject({
      conceptCount: 3,
      kind: "semantic-upstream-consumption",
    });
  });
});

describe("coverage and hygiene", () => {
  const base: Spec = {
    concepts: [
      ...implemented("A", "X", 1),
      ...implemented("B", "X", 1),
      ...implemented("C", "X", 1),
    ],
    edges: ["X→A", "X→B", "X→C"],
  };

  it("caps strength and speaks in lower bounds under partial coverage", () => {
    const patterns = analyze({ ...base, missing: ["C"] });
    const role = rolesOf(patterns, "X")[0];
    expect(role).toMatchObject({
      coverage: "partial",
      kind: "implementation-center",
    });
    expect(role?.strength).not.toBe("strong");
    expect(patterns.cautions.map((c) => c.kind)).toEqual(
      expect.arrayContaining(["partial-coverage", "lower-bound-support"])
    );
    expect(patterns.coveragePatterns[0]).toMatchObject({
      entities: ["C"],
      kind: "partial-package-coverage",
    });
    expect(JSON.stringify(patterns)).not.toMatch(
      /universal|every package|always/i
    );
  });

  it("keeps foreign-only concepts out of ownership roles while counting their conversions", () => {
    const patterns = analyze({
      concepts: [
        { id: "A/One.ts#One", package: "A" },
        { id: "A/Two.ts#Two", package: "A" },
        { id: "B/Three.ts#Three", package: "B" },
        ...["One", "Two", "Three"].map((name) => ({
          foreign: true,
          id: `X/${name}Mirror.ts#${name}Mirror`,
          package: "X",
        })),
      ],
      edges: ["X→A", "X→B"],
      overlaps: [
        ["A", "One"],
        ["A", "Two"],
        ["B", "Three"],
      ].map(([pkg, name]) => ({
        conversions: [
          `to@X/convert.ts:${pkg}/${name}.ts#${name}>X/${name}Mirror.ts#${name}Mirror`,
        ],
        left: `${pkg}/${name}.ts#${name}`,
        right: `X/${name}Mirror.ts#${name}Mirror`,
      })),
    });
    const x = patterns.packages.find((p) => p.package === "X");
    expect(x?.counts).toMatchObject({
      conversionsOwned: 3,
      foreignImplemented: 0,
      foreignRepresented: 0,
    });
    expect(x?.roles.map((r) => r.kind)).toEqual(["conversion-center"]);
  });

  it("separates analyzer blind spots from architecture", () => {
    const patterns = analyze({
      ...base,
      reviews: base.concepts.map((c) => ({
        centers: ["X"],
        conceptId: c.id,
        disposition: "insufficient-evidence",
        unresolved: [
          {
            kind: "partial-simulation",
            uncertainties: ["structural-conformance-unobserved"],
            unmeasuredEdges: ["X→A"],
          },
        ],
      })),
    });
    expect(patterns.coveragePatterns.map((c) => c.kind)).toEqual([
      "structural-conformance-gap",
      "unmeasured-edge",
    ]);
    expect(pairOf(patterns, "A→X").patterns).toEqual([]);
    expect(
      patterns.reviewPatterns.find((r) => r.scope === "gravity-center")
    ).toMatchObject({
      id: "X",
      impactUncertainties: { "structural-conformance-unobserved": 3 },
      unresolvedCauses: { "partial-simulation": 3 },
    });
  });

  it("leaves review-independent patterns byte-identical when reviews are removed", () => {
    const reviewed = analyze({
      ...base,
      reviews: base.concepts.map((c) => ({
        centers: ["X"],
        conceptId: c.id,
        disposition: "insufficient-evidence",
      })),
    });
    const without = analyze(base);
    const strip = (p: WorkspaceArchitecturalPatterns) =>
      JSON.stringify({
        boundaries: p.boundaries,
        conceptPatterns: p.conceptPatterns.map(
          ({ reviews: _r, ...rest }) => rest
        ),
        evolutionaryPatterns: p.evolutionaryPatterns,
        packagePairs: p.packagePairs.map(({ reviews: _r, ...rest }) => rest),
        packages: p.packages.map(({ reviews: _r, ...rest }) => rest),
      });
    expect(strip(reviewed)).toBe(strip(without));
    expect(without.reviewPatterns).toEqual([]);
    expect(reviewed.reviewPatterns.length).toBeGreaterThan(0);
  });

  it("is byte-stable under input reordering", () => {
    const spec: Spec = {
      ...base,
      couplings: [{ left: "A/c0.ts", right: "X/impl.ts" }],
      reviews: [
        {
          centers: ["X"],
          conceptId: base.concepts[0]?.id ?? "",
          disposition: "credible-alternative",
          dominatedBy: "rehome-behavior",
        },
      ],
    };
    const forward = workspace(spec);
    const shuffled = workspace({
      ...spec,
      concepts: [...spec.concepts].reverse(),
      edges: [...(spec.edges ?? [])].reverse(),
    });
    shuffled.concepts.concepts.reverse();
    shuffled.graph.dependencyEdges.reverse();
    shuffled.packages.packages.reverse();
    const run = (ws: typeof forward) => {
      const graph = analyzeWorkspaceGraph(ws);
      return JSON.stringify(
        analyzeWorkspacePatterns(ws, graph, analyzeWorkspaceConcepts(ws, graph))
      );
    };
    expect(run(shuffled)).toBe(run(forward));
  });

  it("carries no score and no recommendation", () => {
    const text = JSON.stringify(
      analyze({
        ...base,
        reviews: base.concepts.map((c) => ({
          centers: ["X"],
          conceptId: c.id,
          disposition: "credible-alternative",
          dominatedBy: "rehome-behavior",
        })),
      })
    );
    expect(text).not.toMatch(/Score"|score"|health|confidence"/i);
    expect(text).not.toMatch(
      /shouldMove|recommendedTarget|"fix"|recommend|should /i
    );
  });

  it("attaches under the workspace intelligence stamp", () => {
    const report = analyzeWorkspace(workspace(base));
    expect(report.intelligence?.patterns?.summary).toMatchObject({
      packageRoles: 1,
      packagesWithRoles: 1,
    });
  });
});
