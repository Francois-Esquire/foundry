import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import {
  createInternalizeOperator,
  createOperatorContext,
  createOperatorFromScenario,
  validateArchitecturalOperator,
} from "../../src/lib/architectural-operator";
import {
  ANALYSIS_POLICY_VERSION,
  WORKSPACE_INTELLIGENCE_POLICY_VERSION,
} from "../../src/lib/config";
import { DEFAULT_MUTATION_CAPABILITIES } from "../../src/lib/mutation-capabilities";
import {
  composeArchitecturalOperators,
  validateOperatorComposition,
} from "../../src/lib/operator-composition";
import {
  decomposeArchitecturalOperator,
  validateOperatorDecomposition,
} from "../../src/lib/operator-decomposition";
import {
  planArchitecturalOperator,
  planOperatorComposition,
  validateOperatorExecutionPlan,
} from "../../src/lib/operator-plan";
import type { OperatorPlanningContext } from "../../src/lib/operator-planning-context";
import { createOperatorPlanningContext } from "../../src/lib/operator-planning-context";
import { assessOperatorPlanReadiness } from "../../src/lib/operator-readiness";
import type { OperatorContext } from "../../src/lib/operator-types";
import { renderOperatorComposition } from "../../src/lib/report-composition";
import { renderOperatorDecomposition } from "../../src/lib/report-decomposition";
import { renderOperator } from "../../src/lib/report-operator";
import { renderOperatorExecutionPlan } from "../../src/lib/report-plan";
import { renderProjectionResult } from "../../src/lib/report-projection";
import {
  renderWorkspaceConcept,
  renderWorkspacePackageGraph,
  renderWorkspaceReport,
} from "../../src/lib/report-workspace";
import type { InternalizeSymbolPlan, SurfaceReport } from "../../src/lib/types";
import { validateReductionPlan } from "../../src/lib/validate";
import { analyzeWorkspaceGraph } from "../../src/lib/workspace-graph";
import { ingestWorkspaceReports } from "../../src/lib/workspace-ingest";
import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import {
  createWorkspaceProjectionContext,
  projectWorkspaceBoundary,
  projectWorkspaceConcept,
  projectWorkspaceOverview,
} from "../../src/lib/workspace-projection";
import {
  listConceptDirections,
  queryWorkspace,
} from "../../src/lib/workspace-projection-views";
import type { WorkspaceReport } from "../../src/lib/workspace-types";

const root = path.join(import.meta.dirname, "fixtures", "locality");
const now = new Date("2027-01-01T00:00:00Z");
const targets = ["app", "core", "plug-a", "plug-b", "store"];

let reports: SurfaceReport[];
let workspace: WorkspaceReport;

beforeAll(async () => {
  reports = await Promise.all(
    targets.map((target) =>
      analyzeSurface({
        now,
        root,
        target: `packages/${target}`,
        tsconfig: "tsconfig.json",
      })
    )
  );
  workspace = ingestWorkspaceReports(reports, { root: "locality" });
});

describe("real package reports", () => {
  it("ingests every fixture package with complete coverage", () => {
    expect(workspace.ingestion).toMatchObject({
      duplicates: 0,
      reportsAccepted: 5,
      reportsReceived: 5,
      reportsRejected: 0,
    });
    expect(workspace.ingestion.coverage.complete).toBe(true);
    expect(workspace.ingestion.coverage.missingPackages).toEqual([]);
    expect(
      workspace.sources.every(
        (s) => s.policyVersion === ANALYSIS_POLICY_VERSION
      )
    ).toBe(true);
    expect(workspace.ingestion.diagnostics).toEqual([]);
  });

  it("holds exactly one concept per seed across all reports", () => {
    const seeds = reports.flatMap((r) =>
      r.conceptInventory.families.map((f) => f.seed.id)
    );
    expect(new Set(seeds).size).toBe(seeds.length);
    const seedConcepts = workspace.concepts.concepts.filter(
      (c) => c.analysis === "seed-report"
    );
    expect(seedConcepts.map((c) => c.id)).toEqual([...seeds].sort());
    expect(
      seedConcepts.every(
        (c) => c.ownership !== undefined && c.locality !== undefined
      )
    ).toBe(true);
    expect(
      workspace.concepts.concepts.filter((c) => c.analysis === "foreign-only")
    ).toEqual([]);
  });

  it("merges both perspectives of a boundary and keeps a destination-only one", () => {
    const boundaries = workspace.boundaries.boundaries;
    expect(boundaries.map((b) => b.id)).toEqual([
      "@l/app→@l/core",
      "@l/app→@l/store",
      "@l/plug-a→@l/core",
      "@l/plug-b→@l/core",
      "@l/store→@l/core",
    ]);
    for (const boundary of boundaries) {
      if (boundary.provenance.observedBy.length === 2) {
        expect(boundary.provenance.observedBy).toEqual(
          [boundary.from, boundary.to].sort()
        );
        expect(boundary.verified).toBe(true);
        expect(boundary.perspectives.source?.observedBy).toBe(boundary.from);
        expect(boundary.perspectives.destination?.observedBy).toBe(boundary.to);
      }
    }
    // app reaches core symbols only through store's re-exports: core's
    // report observes the usage, app's import declarations never name core.
    const viaReExport = boundaries.find((b) => b.id === "@l/app→@l/core");
    expect(viaReExport?.provenance.observedBy).toEqual(["@l/core"]);
    expect(viaReExport?.perspectives.source).toBeUndefined();
    expect(viaReExport?.verified).toBe(false);
    expect(workspace.ingestion.naive.boundary).toBe(9);
    expect(workspace.ingestion.canonical.boundary).toBe(5);
    expect(workspace.ingestion.canonical.dependencyEdge).toBe(5);
    expect(workspace.ingestion.density.moduleEdge.two).toBeGreaterThan(0);
    const unresolved = workspace.ingestion.conflicts.filter(
      (c) => c.resolution === "unresolved"
    );
    expect(unresolved).toEqual([]);
  });

  it("deduplicates overlap pairs observed from both sides", () => {
    const naive = reports.reduce(
      (sum, r) => sum + r.conceptOverlap.candidates.length,
      0
    );
    const crossPackage = workspace.concepts.overlaps.filter(
      (o) => o.crossPackage
    );
    const twice = crossPackage.filter(
      (o) => o.provenance.observedBy.length === 2
    );
    expect(workspace.ingestion.naive.overlap).toBe(naive);
    expect(workspace.concepts.overlaps.length).toBe(naive - twice.length);
    expect(twice.length).toBeGreaterThan(0);
    expect(twice.every((o) => o.verified)).toBe(true);
    // Overlap generation is target-scoped: a pair can surface from one
    // side's seeds only, so single-observer cross-package pairs are expected.
    expect(crossPackage.some((o) => o.provenance.observedBy.length === 1)).toBe(
      true
    );
    expect(
      workspace.ingestion.conflicts.filter((c) => c.entity === "overlap")
    ).toEqual([]);
  });

  it("carries re-centering findings, scenarios, impacts, and reviews with resolved references", () => {
    const recentering = workspace.architecture.recentering;
    const findings = reports.flatMap(
      (r) => r.recenteringCandidates.miscentered.findings
    );
    expect(recentering.findings.map((f) => f.id)).toEqual(
      findings.map((f) => f.id).sort()
    );
    expect(recentering.scenarios.length).toBeGreaterThan(0);
    expect(recentering.scenarios.every((s) => s.resolved)).toBe(true);
    expect(recentering.impacts.every((i) => i.resolved)).toBe(true);
    expect(recentering.reviews.every((r) => r.resolved)).toBe(true);
    expect(recentering.reviews.map((r) => r.findingId)).toEqual(
      recentering.findings.map((f) => f.id)
    );
    const withFinding = workspace.concepts.concepts.filter(
      (c) => c.recentering?.findingId !== undefined
    );
    expect(withFinding.map((c) => c.recentering?.findingId)).toEqual(
      recentering.findings.map((f) => f.id)
    );
  });

  it("is byte-stable under input reordering and round-trips through JSON", () => {
    const reversed = ingestWorkspaceReports([...reports].reverse(), {
      root: "locality",
    });
    const forward = JSON.stringify(workspace);
    expect(JSON.stringify(reversed)).toBe(forward);
    expect(JSON.parse(forward)).toEqual(workspace);
  });

  it("renders a compact summary without interpretation", () => {
    const text = renderWorkspaceReport(workspace);
    expect(text).toContain("WORKSPACE");
    expect(text).toContain("5 accepted · 0 rejected · 0 duplicate");
    expect(text).toContain("complete · 5 of 5 packages analyzed");
    expect(text).not.toMatch(/dominant|hub|drift/);
  });
});

describe("workspace graph over real reports", () => {
  it("recomputes V5 package gravity exactly under complete coverage", () => {
    const graph = analyzeWorkspaceGraph(workspace);
    expect(graph.certainty).toBe("complete");
    expect(graph.topology.usageOnlyEdges).toEqual(["@l/app→@l/core"]);
    for (const pkg of workspace.packages.packages) {
      const node = graph.packages.find((p) => p.package === pkg.id);
      expect(node?.direct).toEqual({
        fanIn: pkg.gravity?.fanIn,
        fanOut: pkg.gravity?.fanOut,
      });
      expect(node?.transitive).toEqual({
        dependencies: pkg.gravity?.transitiveDependencies,
        dependents: pkg.gravity?.transitiveDependents,
      });
      expect(node?.depth).toEqual({
        downstream: pkg.gravity?.downstreamDepth,
        upstream: pkg.gravity?.upstreamDepth,
      });
    }
    expect(graph.reachability.longestPackageChains[0]).toEqual([
      "@l/app",
      "@l/store",
      "@l/core",
    ]);
    expect(graph.topology.packageSources).toEqual([
      "@l/app",
      "@l/plug-a",
      "@l/plug-b",
    ]);
    expect(graph.topology.packageSinks).toEqual(["@l/core"]);
  });

  it("renders the graph section when attached", () => {
    const text = renderWorkspaceReport({
      ...workspace,
      intelligence: { graph: analyzeWorkspaceGraph(workspace) },
    });
    expect(text).toContain("WORKSPACE GRAPH");
    expect(text).toContain("5 nodes · 4 edges · complete coverage");
    expect(text).toContain("app → store → core");
  });
});

describe("workspace concepts over real reports", () => {
  it("preserves per-package participation, source behavior, and member couplings at ingestion", () => {
    const repo = workspace.concepts.concepts.find((c) => c.name === "Repo");
    expect(repo?.ownership?.participation.map((p) => p.package)).toEqual([
      "@l/core",
      "@l/store",
    ]);
    expect(
      repo?.ownership?.participation.find((p) => p.package === "@l/store")
        ?.implementations
    ).toBe(1);
    expect(
      repo?.locality?.behavior.find((b) => b.package === "@l/store")
        ?.implementationBehaviors
    ).toBeGreaterThan(0);
    expect(repo?.evolution).toBeDefined();
  });

  it("places the Repo contract family on the graph", () => {
    const report = analyzeWorkspace(workspace);
    expect(report.intelligence?.policyVersion).toBe(
      WORKSPACE_INTELLIGENCE_POLICY_VERSION
    );
    const concepts = report.intelligence?.concepts;
    expect(concepts?.certainty).toBe("complete");
    expect(concepts?.summary.concepts).toBe(workspace.concepts.concepts.length);
    expect(concepts?.summary.foreignOnly).toBe(0);
    const repo = concepts?.concepts.find((c) => c.concept.name === "Repo");
    expect(repo?.presence).toMatchObject({
      behaviorPackages: ["@l/core", "@l/store"],
      declaredPackage: "@l/core",
      implementationPackages: ["@l/core", "@l/store"],
    });
    expect(repo?.flow.semanticToImplementations).toEqual([
      {
        distance: 1,
        package: "@l/store",
        relation: "direct",
        usageOnly: false,
      },
    ]);
    expect(repo?.shapes).toEqual(
      expect.arrayContaining([
        "downstream-implemented",
        "parallel-implementation",
      ])
    );
    expect(repo?.propagation).toBe("upstream");
    const family = concepts?.families.find((f) => f.name === "Repo");
    expect(family?.categories).toEqual([
      "cross-package-implementation",
      "parallel-implementation",
      "downstream-implementation",
    ]);
    const direction = concepts?.directions.find(
      (d) => d.id === "@l/core→@l/store:semantic-to-implementation"
    );
    expect(direction?.dependencyPath).toEqual({
      forward: null,
      reverse: 1,
      usageOnly: false,
    });
    expect(
      concepts?.boundaries.find((b) => b.boundaryId === "@l/store→@l/core")
        ?.roles.implementation
    ).toBeGreaterThan(0);
  });

  it("keeps the re-export-only app→core edge as usage flow", () => {
    const concepts = analyzeWorkspace(workspace).intelligence?.concepts;
    const viaReExport = concepts?.concepts.filter((c) =>
      c.topology.usageOnlyEdges.includes("@l/app→@l/core")
    );
    expect(viaReExport?.length).toBeGreaterThan(0);
    expect(
      viaReExport?.every((c) =>
        c.topology.edges.every((e) => e.id !== "@l/app→@l/core")
      )
    ).toBe(true);
    expect(
      concepts?.boundaries.some((b) => b.boundaryId === "@l/app→@l/core")
    ).toBe(false);
  });

  it("renders the concept section and a focused concept view", () => {
    const report = analyzeWorkspace(workspace);
    const text = renderWorkspaceReport(report);
    expect(text).toContain("WORKSPACE CONCEPTS");
    expect(text).toContain("core → store · implementation");
    expect(text).not.toMatch(/dominant|hub|drift|subsystem/);
    const focused = renderWorkspaceConcept(report, "Repo");
    expect(focused).toContain("implementation  store direct 1");
    expect(focused).toContain("History");
  });
});

describe("workspace patterns over real reports", () => {
  it("carries review uncertainty kinds and unmeasured edges through ingestion", () => {
    for (const review of workspace.architecture.recentering.reviews) {
      expect(Array.isArray(review.unresolved)).toBe(true);
    }
    for (const impact of workspace.architecture.recentering.impacts) {
      expect(Array.isArray(impact.uncertainties)).toBe(true);
      expect(Array.isArray(impact.unmeasuredEdges)).toBe(true);
    }
  });

  it("synthesizes patterns from the fixture without a score or recommendation", () => {
    const report = analyzeWorkspace(workspace);
    const patterns = report.intelligence?.patterns;
    expect(patterns?.certainty).toBe("complete");
    expect(patterns?.coveragePatterns.map((c) => c.kind)).not.toContain(
      "partial-package-coverage"
    );
    const core = patterns?.packages.find((p) => p.package === "@l/core");
    expect(core?.counts.declaredCrossPackage).toBeGreaterThan(0);
    expect(patterns?.packagePairs.map((p) => p.id)).toContain(
      "@l/core→@l/store"
    );
    const text = JSON.stringify(patterns);
    expect(text).not.toMatch(/Score"|score"|health|shouldMove|recommend/i);
    for (const pattern of patterns?.conceptPatterns ?? []) {
      expect(pattern.support.conceptCount).toBeGreaterThan(0);
      expect(pattern.support.observations.length).toBeGreaterThan(0);
    }
  });

  it("renders the architecture section and package roles", () => {
    const report = analyzeWorkspace(workspace);
    const text = renderWorkspaceReport(report);
    expect(text).toContain("WORKSPACE ARCHITECTURE");
    expect(text).toContain("Statements");
    expect(text).not.toMatch(/should |recommend/);
    const focused = renderWorkspacePackageGraph(report, "@l/core");
    expect(focused).toContain("Architectural roles");
    expect(focused).toContain("pair:@l/core→@l/store");
  });
});

describe("workspace projections over real reports", () => {
  it("projects the Repo story with the test/source split and both static directions", () => {
    const context = createWorkspaceProjectionContext(
      analyzeWorkspace(workspace)
    );
    const repo = workspace.concepts.concepts.find((c) => c.name === "Repo");
    const projection = projectWorkspaceConcept(context, repo?.id ?? "");
    expect(projection?.centers?.implementations).toEqual([
      "@l/core",
      "@l/store",
    ]);
    const store = projection?.participation.find(
      (p) => p.package === "@l/store"
    );
    expect(store?.roles).toEqual(
      expect.arrayContaining(["implements", "behaves"])
    );
    expect(store?.sourceBehaviors).toBeGreaterThan(0);
    expect(typeof store?.testBehaviors).toBe("number");
    expect(projection?.flow.semanticToImplementations).toEqual([
      {
        distance: 1,
        package: "@l/store",
        relation: "direct",
        usageOnly: false,
      },
    ]);
    const direction = listConceptDirections(context, {
      from: "@l/core",
      role: "implementation",
      to: "@l/store",
    }).directions[0];
    expect(direction).toMatchObject({
      from: "@l/core",
      staticDependencyDirection: "reverse",
      to: "@l/store",
    });
    expect(projectWorkspaceBoundary(context, "@l/store→@l/core")).toMatchObject(
      {
        from: "@l/store",
        structure: { inPackageGraph: true },
        to: "@l/core",
      }
    );
  });

  it("answers every query kind and renders text from projections only", () => {
    const context = createWorkspaceProjectionContext(
      analyzeWorkspace(workspace)
    );
    const overview = projectWorkspaceOverview(context);
    expect(overview.coverage).toMatchObject({
      certainty: "complete",
      packagesAnalyzed: 5,
    });
    expect(overview.architecture.packageRoles.length).toBe(
      context.patterns.summary.packageRoles
    );
    for (const query of [
      { kind: "overview" },
      { id: "@l/core", kind: "package" },
      { detail: "summary", id: "@l/core", kind: "package" },
      { id: "Repo", kind: "concept" },
      { id: "@l/store→@l/core", kind: "boundary" },
      { kind: "graph", preset: "architecture-overview" },
      { conceptId: "Repo", kind: "concept-graph" },
      { kind: "matrix", metric: { kind: "package-concept-roles" } },
      {
        kind: "rank",
        rank: { kind: "boundaries", metric: "conceptsPerImportSite" },
      },
      { filter: { role: "implementation" }, kind: "directions" },
      { kind: "reviews" },
      { kind: "search", text: "repo" },
    ] as const) {
      const result = queryWorkspace(context, query);
      expect(result.kind).not.toBe("not-found");
      expect(result.kind).not.toBe("ambiguous");
      const text = renderProjectionResult(result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/should |recommend/);
      expect(JSON.stringify(result)).not.toMatch(
        /"(x|y|color|width|height|font)":/
      );
    }
    const patternId = context.index.patterns[0]?.id ?? "";
    expect(
      queryWorkspace(context, { id: patternId, kind: "pattern" }).kind
    ).toBe("pattern");
  });
});

describe("architectural operators over real reports", () => {
  const SHIFTED = "packages/core/src/shifted.ts#Shifted";
  const SPLIT = "packages/core/src/split.ts#Split";

  function operatorContext() {
    return createOperatorContext(
      createWorkspaceProjectionContext(analyzeWorkspace(workspace)),
      reports
    );
  }

  function scenarioId(conceptId: string, kind: string, proposed?: string) {
    const ids = [...operatorContext().scenarios.keys()].filter(
      (id) =>
        id.startsWith(`${conceptId}::${kind}::`) &&
        (proposed === undefined || id.includes(proposed))
    );
    if (ids.length !== 1) {
      throw new Error(`scenario ${conceptId} ${kind}`);
    }
    return ids[0] ?? "";
  }

  it("attaches every V8 scenario the workspace digests, with impact and review", () => {
    const ctx = operatorContext();
    expect(ctx.scenarios.size).toBe(
      workspace.architecture.recentering.scenarios.length
    );
    for (const source of ctx.scenarios.values()) {
      expect(source.impact?.scenarioId).toBe(source.scenario.id);
      expect(source.review?.findingId).toBe(source.scenario.findingId);
    }
  });

  it("derives a rehome-concept from the Shifted rehome-semantic-center scenario without recomputing V8", () => {
    const ctx = operatorContext();
    const id = scenarioId(SHIFTED, "rehome-semantic-center");
    const result = createOperatorFromScenario(ctx, id);
    if (result.status !== "created") {
      throw new Error(result.reason);
    }
    const op = result.operator;
    const source = ctx.scenarios.get(id);
    expect(op.kind).toBe("rehome-concept");
    expect(op.placement).toEqual({
      current: { package: "@l/core" },
      target: { package: "@l/store" },
    });
    expect(op.intent).toMatchObject({
      reviewId: SHIFTED,
      scenarioId: id,
      source: "architectural-review",
    });
    expect(op.evidence.map((e) => e.source)).toEqual([
      "concept",
      "impact",
      "review",
      "scenario",
    ]);
    expect(
      op.constraints.map((c) => [c.kind, c.entityIds.join(",")])
    ).toContainEqual(["public-contract", "@l/core"]);
    for (const change of source?.impact?.changes ?? []) {
      expect(op.expectedEffects).toContainEqual(
        expect.objectContaining({
          change: change.kind,
          ...(change.from !== undefined && { from: change.from }),
          ...(change.to !== undefined && { to: change.to }),
          certainty: change.certainty === "certain" ? "certain" : "conditional",
        })
      );
    }
    expect(op.preservations).toHaveLength(1);
    expect(op.preservations[0]).toMatchObject({
      entityIds: ["@l/store"],
      kind: "consumer-import-path",
    });
    expect(op.status).toBe("valid");
    expect(validateArchitecturalOperator(op, ctx).status).toBe("valid");
  });

  it("derives rehome-behavior only for the explicitly selected Split consolidation", () => {
    const ctx = operatorContext();
    const ids = [...ctx.scenarios.keys()].filter((id) =>
      id.startsWith(`${SPLIT}::consolidate-behavior::`)
    );
    expect(ids.length).toBe(3);
    const operators = ids.map((id) => {
      const result = createOperatorFromScenario(ctx, id);
      if (result.status !== "created") {
        throw new Error(result.reason);
      }
      return result.operator;
    });
    expect(new Set(operators.map((op) => op.id)).size).toBe(3);
    operators.forEach((op, i) => {
      expect(op.kind).toBe("rehome-behavior");
      expect(op.intent.scenarioId).toBe(ids[i]);
      expect(op.preservations).toContainEqual({
        entityIds: ["@l/core"],
        kind: "semantic-center",
      });
      expect(
        op.subject.kind === "behavior" && op.subject.packages
      ).not.toContain(op.placement.target?.package);
    });
  });

  it("refuses the baseline scenario and keeps V8 facts as the only source", () => {
    const ctx = operatorContext();
    const result = createOperatorFromScenario(
      ctx,
      scenarioId(SHIFTED, "preserve-current")
    );
    if (result.status !== "unsupported") {
      throw new Error("expected unsupported");
    }
    expect(result.scenarioKind).toBe("preserve-current");
    expect(result.reason).toContain("no change");
  });

  it("goes stale when the scenario record is no longer available", () => {
    const withReports = operatorContext();
    const id = scenarioId(SHIFTED, "rehome-behavior");
    const result = createOperatorFromScenario(withReports, id);
    if (result.status !== "created") {
      throw new Error(result.reason);
    }
    const withoutReports = createOperatorContext(
      createWorkspaceProjectionContext(analyzeWorkspace(workspace))
    );
    const validation = validateArchitecturalOperator(
      result.operator,
      withoutReports
    );
    expect(validation.status).toBe("stale");
    expect(validation.currentFingerprint).toBeUndefined();
  });

  it("represents a ready internalize plan without touching the legacy path", () => {
    const ctx = operatorContext();
    const report = reports.find((r) => r.target.name === "@l/plug-b");
    const plan = report?.plans.find(
      (p): p is InternalizeSymbolPlan =>
        p.operation === "internalize-symbol" && p.status === "ready"
    );
    if (report === undefined || plan === undefined) {
      throw new Error("fixture");
    }
    const before = JSON.stringify(plan);
    const op = createInternalizeOperator(ctx, plan.id);
    expect(op).toMatchObject({
      fingerprint: { hash: plan.fingerprint },
      intent: { planId: plan.id, source: "existing-plan" },
      kind: "internalize",
      status: "valid",
    });
    expect(op.subject).toMatchObject({
      kind: "symbol",
      symbolId: plan.subject.id,
    });
    expect(op.expectedEffects).toEqual([
      expect.objectContaining({ certainty: "certain", dimension: "surface" }),
    ]);
    expect(validateArchitecturalOperator(op, ctx).status).toBe("valid");
    expect(validateReductionPlan(plan, report).status).toBe("ready");
    expect(JSON.stringify(plan)).toBe(before);
    expect(renderOperator(op)).toContain("internalize");
  });
});

describe("operator decomposition over real reports", () => {
  const SHIFTED = "packages/core/src/shifted.ts#Shifted";
  const SPLIT = "packages/core/src/split.ts#Split";

  function operatorContext() {
    return createOperatorContext(
      createWorkspaceProjectionContext(analyzeWorkspace(workspace)),
      reports
    );
  }

  function fromScenario(ctx: OperatorContext, id: string) {
    const result = createOperatorFromScenario(ctx, id);
    if (result.status !== "created") {
      throw new Error(result.reason);
    }
    return result.operator;
  }

  it("decomposes a ready internalize plan completely, without touching the plan", () => {
    const ctx = operatorContext();
    const plan = [...ctx.legacyPlansById.values()].find(
      (entry) => entry.plan.status === "ready"
    )?.plan;
    if (plan === undefined) {
      throw new Error("fixture");
    }
    const before = JSON.stringify(plan);
    const op = createInternalizeOperator(ctx, plan.id);
    const d = decomposeArchitecturalOperator(op, ctx);
    expect(d.status).toBe("complete");
    expect(d.actions.map((a) => a.kind)).toEqual(["internalize-old-exposure"]);
    expect(d.actions[0]?.subject).toEqual({
      kind: "exposure",
      package: plan.target.package,
      symbolId: plan.subject.id,
    });
    expect(d.unresolved).toEqual([]);
    expect(d.effectCoverage.every((c) => c.status === "covered")).toBe(true);
    expect(d.verificationCoverage.every((c) => c.status === "covered")).toBe(
      true
    );
    expect(validateOperatorDecomposition(d, op, ctx).status).toBe("valid");
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("partitions the Shifted rehome-concept's V8 effects across actions without a new prediction", () => {
    const ctx = operatorContext();
    const id = [...ctx.scenarios.keys()].find((s) =>
      s.startsWith(`${SHIFTED}::rehome-semantic-center::`)
    );
    const op = fromScenario(ctx, id ?? "");
    const d = decomposeArchitecturalOperator(op, ctx);
    expect(d.status).toBe("partial");
    expect(d.actions.map((a) => a.kind)).toContain(
      "relocate-semantic-declaration"
    );
    expect(d.actions.map((a) => a.kind)).toContain("preserve-public-exposure");
    const carried = d.actions.flatMap((a) => a.expectedEffects);
    for (const effect of carried) {
      expect(op.expectedEffects).toContainEqual(effect);
    }
    for (const c of d.effectCoverage) {
      if (c.status === "unresolved") {
        expect(d.unresolved.map((g) => g.kind)).toContain(
          c.operatorEffectId.startsWith("representation:")
            ? "representation-strategy-unspecified"
            : "dependency-target-unresolved"
        );
      }
    }
    expect(validateOperatorDecomposition(d, op, ctx).status).toBe("valid");
    expect(renderOperatorDecomposition(op, d)).toContain(
      "relocate-semantic-declaration"
    );
  });

  it("decomposes each explicitly selected Split consolidation on its own", () => {
    const ctx = operatorContext();
    const ids = [...ctx.scenarios.keys()].filter((s) =>
      s.startsWith(`${SPLIT}::consolidate-behavior::`)
    );
    const decompositions = ids.map((id) =>
      decomposeArchitecturalOperator(fromScenario(ctx, id), ctx)
    );
    expect(new Set(decompositions.map((d) => d.operatorId)).size).toBe(
      ids.length
    );
    for (const d of decompositions) {
      expect(d.status).toBe("partial");
      expect(
        d.actions.filter((a) => a.kind === "relocate-behavior-responsibility")
          .length
      ).toBeGreaterThan(0);
      expect(
        d.preservationCoverage.every((c) => c.status !== "uncovered")
      ).toBe(true);
      expect(d.unresolved.map((g) => g.kind)).toContain(
        "target-module-unresolved"
      );
    }
  });

  it("composes the Shifted rehome-concept with a ready internalize plan into one valid graph", () => {
    const ctx = operatorContext();
    const id = [...ctx.scenarios.keys()].find((s) =>
      s.startsWith(`${SHIFTED}::rehome-semantic-center::`)
    );
    const rehome = fromScenario(ctx, id ?? "");
    const plan = [...ctx.legacyPlansById.values()].find(
      (entry) => entry.plan.status === "ready"
    )?.plan;
    if (plan === undefined) {
      throw new Error("fixture");
    }
    const internal = createInternalizeOperator(ctx, plan.id);
    const decompositions = [rehome, internal].map((op) =>
      decomposeArchitecturalOperator(op, ctx)
    );
    const composition = composeArchitecturalOperators(
      [internal, rehome],
      decompositions,
      ctx
    );
    expect(composition.operators).toHaveLength(2);
    expect(composition.conflicts).toEqual([]);
    expect(composition.status).toBe("partial");
    expect(composition.diagnostics.inputActions).toBe(
      decompositions.reduce((n, d) => n + d.actions.length, 0)
    );
    expect(composition.diagnostics.redecomposed).toEqual([]);
    expect(
      composition.actions.every((a) => a.sourceOperators.length === 1)
    ).toBe(true);
    expect(
      validateOperatorComposition(
        composition,
        [rehome, internal],
        decompositions,
        ctx
      ).status
    ).toBe("valid");
    expect(renderOperatorComposition(composition)).toContain(
      "OPERATOR COMPOSITION"
    );
  });
});

describe("operator planning against the fixture sources", () => {
  const SHIFTED = "packages/core/src/shifted.ts#Shifted";
  let planning: OperatorPlanningContext;

  beforeAll(() => {
    planning = createOperatorPlanningContext({
      root,
      tsconfig: "tsconfig.json",
    });
  });

  function planScenario(kind: string) {
    const ctx = createOperatorContext(
      createWorkspaceProjectionContext(analyzeWorkspace(workspace)),
      reports
    );
    const id = [...ctx.scenarios.keys()].find((s) =>
      s.startsWith(`${SHIFTED}::${kind}::`)
    );
    const result = createOperatorFromScenario(ctx, id ?? "");
    if (result.status !== "created") {
      throw new Error(result.reason);
    }
    const operator = result.operator;
    const decomposition = decomposeArchitecturalOperator(operator, ctx);
    const composition = composeArchitecturalOperators(
      [operator],
      [decomposition],
      ctx
    );
    const plan = planOperatorComposition(
      composition,
      [operator],
      planning,
      ctx
    );
    const validation = validateOperatorExecutionPlan(
      plan,
      composition,
      [operator],
      planning,
      ctx
    );
    return { operator, plan, validation };
  }

  it("plans the Shifted rehome-behavior as five factory moves into the concept's module", () => {
    const { plan, validation } = planScenario("rehome-behavior");
    expect(plan.status).toBe("ready");
    expect(validation.status).toBe("valid");
    const moves = plan.transformations.filter((t) => t.kind === "move-symbol");
    expect(
      moves.map((t) => t.subject?.symbolId?.split("#").pop()).sort()
    ).toEqual([
      "shiftedFive",
      "shiftedFour",
      "shiftedOne",
      "shiftedThree",
      "shiftedTwo",
    ]);
    expect(new Set(moves.map((t) => t.after?.module))).toEqual(
      new Set(["packages/core/src/shifted.ts"])
    );
    expect(plan.relocations.map((r) => r.targetResolution)).toEqual([
      "concept-declaration-module",
      "concept-declaration-module",
    ]);
    expect(
      plan.relocations.every((r) =>
        r.members.every((m) => m.role === "factory")
      )
    ).toBe(true);
    expect(
      plan.transformations.filter((t) => t.kind === "delete-empty-module")
    ).toHaveLength(2);
    expect(plan.realizations.every((r) => r.status === "realized")).toBe(true);
    expect(renderOperatorExecutionPlan(plan, validation)).toContain(
      "OPERATOR PLAN"
    );
  });

  it("blocks the Shifted semantic-center move on the package cycle it would close", () => {
    const { plan } = planScenario("rehome-semantic-center");
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.map((b) => b.kind)).toEqual(["dependency-cycle-risk"]);
    expect(plan.relocations[0]).toMatchObject({
      granularity: "symbol",
      strategy: "compatibility-reexport",
      targetModule: "packages/store/src/shifted-factories.ts",
      targetResolution: "representation-module",
    });
  });

  it("plans a ready legacy internalize plan as one export removal", () => {
    const ctx = createOperatorContext(
      createWorkspaceProjectionContext(analyzeWorkspace(workspace)),
      reports
    );
    const legacy = [...ctx.legacyPlansById.values()].find(
      (entry) => entry.plan.status === "ready"
    )?.plan;
    if (legacy === undefined) {
      throw new Error("fixture");
    }
    const operator = createInternalizeOperator(ctx, legacy.id);
    const plan = planArchitecturalOperator(
      operator,
      decomposeArchitecturalOperator(operator, ctx),
      planning,
      ctx
    );
    expect(plan.status).toBe("ready");
    expect(plan.transformations.map((t) => t.kind)).toEqual(["remove-export"]);
    expect(plan.transformations[0]?.file).toBe(legacy.plannedChanges[0]?.file);
  });

  it("judges the Shifted relocation ready in every dimension but the test script it cannot run", () => {
    const { operator, plan } = planScenario("rehome-behavior");
    const ctx = createOperatorContext(
      createWorkspaceProjectionContext(analyzeWorkspace(workspace)),
      reports
    );
    const composition = composeArchitecturalOperators(
      [operator],
      [decomposeArchitecturalOperator(operator, ctx)],
      ctx
    );
    const readiness = assessOperatorPlanReadiness(plan, {
      capabilities: {
        capabilities: [
          ...DEFAULT_MUTATION_CAPABILITIES.capabilities,
          ...(["move-symbol", "delete-empty-module"] as const).map(
            (transformationKind) => ({
              atomic: true,
              reversible: true,
              supportedForms: ["*"],
              transformationKind,
            })
          ),
        ],
        version: 99,
      },
      composition,
      facts: ctx,
      git: false,
      operators: [operator],
      planning,
    });
    expect(readiness.sourceState.unchanged).toBe(true);
    expect(readiness.completeness.complete).toBe(true);
    expect(readiness.consistency.consistent).toBe(true);
    expect(readiness.constraints.compatible).toBe(true);
    expect(readiness.realizability.realizable).toBe(true);
    expect(readiness.rollback.complete).toBe(true);
    expect(readiness.rollback.deletedFiles).toHaveLength(2);
    expect(readiness.authorization).toBe("not-authorized");
    expect([...new Set(readiness.blockers.map((b) => b.kind))]).toEqual([
      "verification-incomplete",
    ]);
    expect(
      assessOperatorPlanReadiness(plan, {
        composition,
        facts: ctx,
        git: false,
        operators: [operator],
        planning,
      }).authorization
    ).toBe("unsupported");
  });
});
