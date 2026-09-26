import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { analyzeRecenteringCandidates } from "../../src/lib/concept-recentering";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { renderConcepts } from "../../src/lib/report";
import {
  renderArchitecturalReview,
  renderMiscenteredFinding,
  renderRecenteringCandidate,
  renderRecenteringScenarios,
  renderScenarioImpacts,
} from "../../src/lib/report-recentering";
import type {
  ArchitecturalScenarioReview,
  MiscenteredConceptFinding,
  RecenteringCandidate,
  RecenteringScenario,
  RecenteringScenarioFinding,
  ReviewedScenario,
  ScenarioImpactAnalysis,
  ScenarioImpactFinding,
  SurfaceReport,
} from "../../src/lib/types";

const root = path.join(import.meta.dirname, "fixtures", "locality");
const now = new Date("2027-01-01T00:00:00Z");

let report: SurfaceReport;

function candidate(name: string): RecenteringCandidate {
  const found = report.recenteringCandidates.candidates.find(
    (item) => item.subject.concept.name === name
  );
  if (!found) {
    throw new Error(`re-centering entry not found: ${name}`);
  }
  return found;
}

function emitted(name: string): boolean {
  return report.recenteringCandidates.candidates.some(
    (item) => item.subject.concept.name === name
  );
}

beforeAll(async () => {
  report = await analyzeSurface({
    now,
    root,
    target: "packages/core",
    tsconfig: "tsconfig.json",
  });
});

describe("candidates", () => {
  it("reads a concept declared in one package but produced in another as mis-centered", () => {
    const shifted = candidate("Shifted");
    expect(shifted.status).toBe("candidate");
    expect(shifted.shapes).toEqual(["mis-centered", "representation-drift"]);
    expect(shifted.tensions).toEqual([
      "semantic-vs-representation",
      "semantic-vs-behavior",
      "dependency-misalignment",
    ]);
    expect(shifted.strongTensions).toEqual([
      "semantic-vs-representation",
      "semantic-vs-behavior",
    ]);
    expect(shifted.dimensions).toEqual([
      "representation",
      "behavior",
      "dependency",
    ]);
    expect(shifted.currentPlacement).toMatchObject({
      behaviorPackages: ["@l/store"],
      implementationCenters: [],
      representationCenter: "@l/store",
      seedPackage: "@l/core",
      semanticCenter: "@l/core",
      usageCenter: "@l/store",
    });
    expect(shifted.behavior).toMatchObject({
      primaryStrongPackage: "@l/store",
      primaryStrongShare: 1,
      source: 5,
      strong: 5,
      weak: 0,
    });
    expect(shifted.behavior.byKind.return).toBe(5);
    expect(shifted.locality.shape).toBe("local");
  });

  it("reads implementations plus producers across three packages as behaviorally scattered", () => {
    const scattered = candidate("Scattered");
    expect(scattered.status).toBe("candidate");
    expect(scattered.shapes).toEqual([
      "behaviorally-scattered",
      "implementation-drift",
    ]);
    expect(scattered.tensions).toEqual([
      "behavioral-scatter",
      "implementation-scatter",
    ]);
    expect(scattered.currentPlacement.implementationCenters).toEqual([
      "@l/core",
      "@l/store",
    ]);
    expect(
      scattered.behavior.byPackage.map((row) => [
        row.package,
        row.byKind.implementation,
        row.byKind.return,
      ])
    ).toEqual([
      ["@l/core", 2, 1],
      ["@l/store", 2, 1],
      ["@l/app", 0, 2],
    ]);
    expect(scattered.behavior.strongModules).toBe(6);
    expect(scattered.behavior.topTwoStrongModuleShare).toBe(0.5);
    expect(scattered.locality.shape).toBe("cross-package-distributed");
  });

  it("never emits a concept whose spread is parameter consumption", () => {
    expect(emitted("Wide")).toBe(false);
    const wide = report.conceptBehavioralLocality.concepts.find(
      (item) => item.concept.name === "Wide"
    );
    expect(wide?.shape.primary).toBe("cross-package-distributed");
  });

  it("never emits a healthy contract/implementation split or a persistence pair", () => {
    expect(emitted("Repo")).toBe(false);
    expect(emitted("Domain")).toBe(false);
    expect(emitted("Plugin")).toBe(false);
    expect(emitted("Token")).toBe(false);
  });

  it("orders by strong tensions, then dimensions", () => {
    expect(
      report.recenteringCandidates.candidates.map(
        (item) => item.subject.concept.name
      )
    ).toEqual(["Shifted", "Scattered", "Drift"]);
  });
});

describe("intent", () => {
  it("keeps the evidence and marks the candidate protected when the seed package is anchored", () => {
    const anchored = analyzeRecenteringCandidates(report, {
      ...ANALYSIS_CONFIG,
      anchors: [{ reason: "core is fixed", target: "@l/core" }],
    });
    expect(anchored.summary).toMatchObject({
      candidates: 0,
      insufficientEvidence: 1,
      protected: 2,
    });
    const shifted = anchored.candidates.find(
      (item) => item.subject.concept.name === "Shifted"
    );
    expect(shifted?.status).toBe("protected");
    expect(shifted?.shapes).toEqual([
      "mis-centered",
      "representation-drift",
      "intent-protected",
    ]);
    expect(shifted?.intent).toEqual({
      anchoredObservedPackages: [],
      anchorReason: "core is fixed",
      representationBoundaries: [],
      seedAnchored: true,
    });
    expect(shifted?.tensions).toEqual(candidate("Shifted").tensions);
  });
});

describe("independence", () => {
  it("leaves V7 results untouched and names no destination", () => {
    expect(report.conceptBehavioralLocality.summary.analyzed).toBe(20);
    const ownership = report.conceptOwnership.concepts.find(
      (item) => item.concept.name === "Shifted"
    );
    expect(ownership?.alignment).toBe("divergent");
    const text = JSON.stringify(report.recenteringCandidates);
    for (const word of ["destination", "moveTo", "score", "opportunit"]) {
      expect(text).not.toContain(word);
    }
  });
});

describe("report", () => {
  it("summarizes candidates, shapes, and tensions", () => {
    expect(report.schemaVersion).toBe(35);
    expect(report.recenteringCandidates.target).toBe("@l/core");
    expect(report.recenteringCandidates.summary).toEqual({
      byShape: {
        "behaviorally-scattered": 1,
        "boundary-strained": 0,
        "implementation-drift": 2,
        "intent-protected": 0,
        "mis-centered": 1,
        "representation-drift": 1,
      },
      byTension: {
        "anchor-conflict": 0,
        "behavioral-scatter": 1,
        "boundary-friction": 0,
        "dependency-misalignment": 1,
        "implementation-scatter": 2,
        "semantic-vs-behavior": 1,
        "semantic-vs-evolution": 0,
        "semantic-vs-representation": 1,
        "temporal-misalignment": 0,
      },
      candidates: 2,
      evaluated: 20,
      insufficientEvidence: 1,
      protected: 0,
    });
  });

  it("renders the section and the focused view", () => {
    const text = renderConcepts(report);
    expect(text).toContain("RE-CENTERING CANDIDATES");
    expect(text).toContain("2 candidates · 0 protected");
    expect(text).toContain("Shifted");
    const focused = renderRecenteringCandidate(candidate("Shifted"));
    expect(focused).toContain("status             candidate · mis-centered");
    expect(focused).toContain("semantic-vs-behavior (strong)");
    expect(focused).toContain("100.0% (@l/store) · concept-ownership");
    expect(focused).not.toContain("score");
    expect(renderRecenteringCandidate(undefined)).toContain(
      "no tension recorded"
    );
  });
});

describe("mis-centered concepts", () => {
  function finding(name: string): MiscenteredConceptFinding {
    const found = report.recenteringCandidates.miscentered.findings.find(
      (item) => item.concept.name === name
    );
    if (!found) {
      throw new Error(`mis-centering finding not found: ${name}`);
    }
    return found;
  }

  function outcome(name: string): string {
    const found = report.recenteringCandidates.miscentered.assessed.find(
      (item) => item.concept.name === name
    );
    if (!found) {
      throw new Error(`assessment not found: ${name}`);
    }
    return found.outcome;
  }

  it("reads a concept declared in core but produced in store as external gravity", () => {
    const shifted = finding("Shifted");
    expect(shifted.signal).toBe("external-gravity");
    expect(shifted.declaredHome).toEqual({
      anchored: false,
      module: "packages/core/src/shifted.ts",
      package: "@l/core",
    });
    expect(shifted.observedCenters.map((center) => center.target)).toEqual([
      "@l/store",
      "@l/core",
    ]);
    expect(shifted.observedCenters[0]?.gravity).toBeGreaterThan(0.9);
    expect(shifted.supportingFamilies).toEqual([
      "behavioral-locality",
      "symbol-distribution",
      "consumer-gravity",
      "dependency-gravity",
    ]);
    expect(shifted.evidenceConfidence).toBeCloseTo(0.8, 5);
    expect(shifted.anchored).toBe(false);
  });

  it("reads equal production across three packages as split gravity", () => {
    const split = finding("Split");
    expect(split.signal).toBe("split-gravity");
    expect(split.observedCenters.every((center) => center.gravity < 0.5)).toBe(
      true
    );
    expect(split.supportingFamilies).toContain("behavioral-locality");
    expect(split.supportingFamilies).toContain("concept-distribution");
    expect(split.summary).toContain("no dominant observed center");
  });

  it("reads a model kept in core with behavior in store and app as boundary drift", () => {
    const drift = finding("Drift");
    expect(drift.signal).toBe("boundary-drift");
    expect(drift.supportingFamilies).toEqual([
      "behavioral-locality",
      "boundary-crossing",
    ]);
    expect(drift.observedCenters[0]?.target).toBe("@l/core");
    expect(drift.mismatch).toBeLessThan(0);
  });

  it("returns no finding for consumption, adapters, shared types, and persistence pairs", () => {
    expect(outcome("Wide")).toBe("behavior-light");
    expect(outcome("Token")).toBe("behavior-light");
    expect(outcome("Repo")).toBe("behavior-light");
    expect(outcome("Plugin")).toBe("behavior-light");
    expect(outcome("Domain")).toBe("unclear");
    expect(outcome("Scattered")).toBe("unclear");
  });

  it("keeps findings under an anchored home and marks them", () => {
    const anchored = analyzeRecenteringCandidates(report, {
      ...ANALYSIS_CONFIG,
      anchors: [{ reason: "core is fixed", target: "@l/core" }],
    }).miscentered;
    expect(anchored.findings.map((item) => item.concept.name)).toEqual(
      report.recenteringCandidates.miscentered.findings.map(
        (item) => item.concept.name
      )
    );
    expect(anchored.summary.anchored).toBe(3);
    const shifted = anchored.findings.find(
      (item) => item.concept.name === "Shifted"
    );
    expect(shifted?.anchored).toBe(true);
    expect(shifted?.declaredHome.anchorReason).toBe("core is fixed");
    expect(shifted?.cautions.map((item) => item.kind)).toEqual([
      "declared-home-anchored",
    ]);
  });

  it("surfaces an anchored observed center", () => {
    const anchored = analyzeRecenteringCandidates(report, {
      ...ANALYSIS_CONFIG,
      anchors: [{ target: "@l/store" }],
    }).miscentered;
    const shifted = anchored.findings.find(
      (item) => item.concept.name === "Shifted"
    );
    expect(shifted?.anchored).toBe(false);
    expect(shifted?.observedCenters[0]).toMatchObject({
      anchored: true,
      target: "@l/store",
    });
    expect(shifted?.cautions.map((item) => item.kind)).toEqual([
      "observed-center-anchored",
    ]);
  });

  it("summarizes, orders by confidence, and renders", () => {
    const { summary, findings } = report.recenteringCandidates.miscentered;
    expect(findings.map((item) => item.concept.name)).toEqual([
      "Shifted",
      "Split",
      "Drift",
    ]);
    expect(summary).toEqual({
      anchored: 0,
      bySignal: {
        "boundary-drift": 1,
        "external-gravity": 1,
        "split-gravity": 1,
      },
      evaluated: 20,
      findings: 3,
      outcomes: {
        aligned: 0,
        "behavior-light": 15,
        finding: 3,
        unclear: 2,
        "usage-only": 0,
      },
    });
    const text = renderConcepts(report);
    expect(text).toContain("MIS-CENTERED CONCEPTS");
    expect(text).toContain("1. Shifted");
    expect(text).toContain("@l/core → gravity toward @l/store");
    expect(text).toContain("external-gravity · evidence 80.0%");
    const focused = renderMiscenteredFinding(finding("Split"));
    expect(focused).toContain("signal             split gravity");
    expect(focused).toContain("no dominant structural center detected");
    expect(focused).toContain("▲ behavioral-locality");
    expect(renderMiscenteredFinding(undefined, "behavior-light")).toContain(
      "no finding (behavior-light)"
    );
    const json = JSON.stringify(report.recenteringCandidates.miscentered);
    for (const word of ["destination", "moveTo", "score", "recommend"]) {
      expect(json).not.toContain(word);
    }
  });
});

describe("re-centering scenarios", () => {
  function scenariosOf(name: string): RecenteringScenarioFinding {
    const found = report.recenteringCandidates.scenarios.findings.find(
      (item) => item.subject.name === name
    );
    if (!found) {
      throw new Error(`scenario entry not found: ${name}`);
    }
    return found;
  }

  function packagesOf(
    item: RecenteringScenario | undefined,
    responsibility: string
  ) {
    return item?.proposed.responsibilities.find(
      (row) => row.responsibility === responsibility
    )?.packages;
  }

  it("gives an external finding the baseline and both readings", () => {
    const shifted = scenariosOf("Shifted");
    expect(shifted.candidateCenters.map((center) => center.package)).toEqual([
      "@l/core",
      "@l/store",
    ]);
    expect(shifted.scenarios.map((item) => item.kind)).toEqual([
      "preserve-current",
      "rehome-semantic-center",
      "rehome-behavior",
    ]);
    const [baseline, semantic, behavior] = shifted.scenarios;
    expect(baseline?.current).toEqual({
      responsibilities: [
        { packages: ["@l/core"], responsibility: "semantic-contract" },
        { packages: ["@l/store"], responsibility: "domain-behavior" },
        {
          packages: ["@l/core", "@l/store"],
          responsibility: "representation",
        },
        { packages: ["@l/store"], responsibility: "consumption" },
      ],
      semanticCenter: "@l/core",
    });
    expect(semantic?.proposed.semanticCenter).toBe("@l/store");
    expect(semantic?.status).toBe("constrained");
    expect(semantic?.constraints).toEqual([
      { kind: "public-contract", package: "@l/core" },
    ]);
    expect(packagesOf(behavior, "domain-behavior")).toEqual(["@l/core"]);
    expect(behavior?.status).toBe("plausible");
  });

  it("gives a split finding consolidation toward each supported center", () => {
    const split = scenariosOf("Split");
    expect(split.scenarios.map((item) => item.kind)).toEqual([
      "preserve-current",
      "consolidate-behavior",
      "consolidate-behavior",
      "consolidate-behavior",
    ]);
    expect(
      split.scenarios
        .slice(1)
        .map((item) => packagesOf(item, "domain-behavior"))
    ).toEqual([["@l/app"], ["@l/core"], ["@l/store"]]);
    expect(
      split.scenarios[0]?.rationale.find(
        (item) => item.kind === "localized-current-split"
      )?.detail
    ).toBe("@l/app 33%, @l/core 33%, @l/store 33%");
  });

  it("keeps drift conservative", () => {
    const drift = scenariosOf("Drift");
    expect(drift.scenarios.map((item) => item.kind)).toEqual([
      "preserve-current",
      "consolidate-behavior",
    ]);
    expect(drift.scenarios[1]?.status).toBe("plausible");
  });

  it("blocks a semantic rehome out of an anchored home", () => {
    const anchored = analyzeRecenteringCandidates(report, {
      ...ANALYSIS_CONFIG,
      anchors: [{ reason: "core is fixed", target: "@l/core" }],
    }).scenarios;
    const shifted = anchored.findings.find(
      (item) => item.subject.name === "Shifted"
    );
    const semantic = shifted?.scenarios.find(
      (item) => item.kind === "rehome-semantic-center"
    );
    expect(semantic?.status).toBe("blocked");
    expect(semantic?.constraints[0]).toEqual({
      kind: "anchor",
      package: "@l/core",
      reason: "core is fixed",
    });
    expect(semantic?.anchorContext.homeAnchored).toBe(true);
    expect(
      shifted?.scenarios.find((item) => item.kind === "rehome-behavior")?.status
    ).toBe("plausible");
    expect(anchored.summary.blocked).toBe(1);
    expect(anchored.summary.blockedByAnchor).toBe(1);
  });

  it("constrains movement into an anchored observed center", () => {
    const anchored = analyzeRecenteringCandidates(report, {
      ...ANALYSIS_CONFIG,
      anchors: [{ target: "@l/store" }],
    }).scenarios;
    const semantic = anchored.findings
      .find((item) => item.subject.name === "Shifted")
      ?.scenarios.find((item) => item.kind === "rehome-semantic-center");
    expect(semantic?.status).toBe("constrained");
    expect(semantic?.constraints.map((item) => item.kind)).toEqual([
      "anchor",
      "public-contract",
    ]);
    expect(semantic?.cautions.map((item) => item.kind)).toContain(
      "observed-center-anchored"
    );
  });

  it("summarizes and renders without preferring anything", () => {
    const { summary, findings } = report.recenteringCandidates.scenarios;
    expect(findings.map((item) => item.subject.name)).toEqual([
      "Shifted",
      "Split",
      "Drift",
    ]);
    expect(summary).toEqual({
      baselineOnly: 0,
      blocked: 0,
      blockedByAnchor: 0,
      byDestination: { "@l/app": 1, "@l/core": 3, "@l/store": 2 },
      byKind: {
        "consolidate-behavior": 4,
        "formalize-representation-boundary": 0,
        "preserve-current": 3,
        "rehome-behavior": 1,
        "rehome-semantic-center": 1,
        "split-responsibility": 0,
      },
      candidateCenters: { one: 0, threePlus: 2, two: 1 },
      constrained: 1,
      constrainedByIncompleteEvidence: 0,
      findings: 3,
      findingsWithAlternatives: 3,
      plausible: 8,
      scenarios: 9,
      scenariosPerFinding: { max: 4, p50: 3, p90: 4 },
      skipped: {
        aligned: 0,
        "behavior-light": 15,
        unclear: 2,
        "usage-only": 0,
      },
    });
    const text = renderConcepts(report);
    expect(text).toContain("RE-CENTERING SCENARIOS");
    expect(text).toContain("1. Shifted (external gravity)");
    expect(text).toContain("B. semantic center → @l/store · constrained");
    expect(text).toContain(
      "C. behavior → @l/core · semantic contract stays @l/core"
    );
    const focused = renderRecenteringScenarios(scenariosOf("Split"));
    expect(focused).toContain("candidate centers  @l/app [behavior 33.3%");
    expect(focused).toContain("A. preserve current");
    expect(focused).toContain("localized-current-split");
    expect(renderRecenteringScenarios(undefined)).toContain("no scenarios");
    const json = JSON.stringify(report.recenteringCandidates.scenarios);
    for (const word of [
      "predictedDelta",
      "importChanges",
      "dependencyChanges",
      "filesMoved",
      "recommended",
      "preferred",
      "winner",
      "rank",
      "score",
    ]) {
      expect(json).not.toContain(word);
    }
  });
});

describe("scenario impact", () => {
  function impactsOf(name: string): ScenarioImpactFinding {
    const found = report.recenteringCandidates.impacts.findings.find(
      (item) => item.subject.name === name
    );
    if (!found) {
      throw new Error(`impact entry not found: ${name}`);
    }
    return found;
  }

  function analysis(name: string, kind: string): ScenarioImpactAnalysis {
    const found = impactsOf(name).scenarios.find((item) => item.kind === kind);
    if (!found) {
      throw new Error(`no ${kind} impact for ${name}`);
    }
    return found;
  }

  it("simulates every V8.2 scenario under its own id", () => {
    const scenarioIds = report.recenteringCandidates.scenarios.findings.flatMap(
      (finding) => finding.scenarios.map((item) => item.id)
    );
    const impactIds = report.recenteringCandidates.impacts.findings.flatMap(
      (finding) => finding.scenarios.map((item) => item.scenarioId)
    );
    expect(impactIds).toEqual(scenarioIds);
  });

  it("keeps the baseline at zero delta with the current facts", () => {
    const baseline = analysis("Split", "preserve-current");
    expect(baseline.changes).toEqual([]);
    expect(baseline.impact.locality.sourcePackageCount).toEqual({
      certainty: "certain",
      current: 3,
      delta: 0,
      predicted: 3,
    });
    expect(baseline.impact.boundaries.preserved).toEqual([
      "@l/app → @l/core",
      "@l/app → @l/store",
      "@l/store → @l/core",
    ]);
    expect(baseline.status).toBe("simulated");
  });

  it("moves the contract with certainty and leaves the consumer edge and surface unresolved", () => {
    const semantic = analysis("Shifted", "rehome-semantic-center");
    expect(semantic.changes.map((change) => change.kind)).toEqual([
      "semantic-center-change",
      "boundary-reduction",
      "surface-relocation",
    ]);
    expect(semantic.impact.surface).toMatchObject({
      consumers: { impact: "unresolved", packages: ["@l/store"] },
      packagePublicContractRelocated: true,
      publicExposureAdded: ["@l/store"],
      publicExposureRemoved: ["@l/core"],
      reexportRequirement: "unknown",
    });
    expect(semantic.impact.locality.sourcePackageCount.delta).toBe(0);
    expect(semantic.impact.boundaries.reduced[0]).toMatchObject({
      certainty: "conditional",
      conceptInteractionEnds: true,
      edge: "@l/store → @l/core",
    });
    expect(semantic.impact.dependency.removed).toEqual([]);
  });

  it("contracts the span for a consolidation and keeps shared edges reduced, never eliminated", () => {
    const consolidate = analysis("Drift", "consolidate-behavior");
    expect(consolidate.impact.locality.sourcePackageCount).toEqual({
      certainty: "certain",
      current: 3,
      delta: -2,
      predicted: 1,
    });
    expect(consolidate.impact.locality.sourceModuleCount.certainty).toBe(
      "unknown"
    );
    expect(consolidate.impact.boundaries.eliminated).toEqual([]);
    expect(
      consolidate.impact.boundaries.reduced.map((row) => row.edge)
    ).toEqual(["@l/app → @l/core", "@l/store → @l/core"]);
    expect(consolidate.impact.behavior.packagesRemoved).toEqual([
      "@l/app",
      "@l/store",
    ]);
    expect(consolidate.uncertainties.map((row) => row.kind)).toContain(
      "target-module-unknown"
    );
    expect(consolidate.status).toBe("partially-simulated");
  });

  it("summarizes, renders, and prefers nothing", () => {
    const { summary } = report.recenteringCandidates.impacts;
    expect(summary).toMatchObject({
      anchorConflicts: 0,
      blocked: 0,
      boundaryAdditions: 0,
      boundaryEliminations: 0,
      boundaryReductions: 8,
      certainChanges: 7,
      conditionalChanges: 8,
      dependencyEliminations: 0,
      localityDecreases: 4,
      localityIncreases: 0,
      partiallySimulated: 4,
      representationBoundariesPreserved: 0,
      scenarios: 9,
      simulated: 5,
      surfaceRelocations: 1,
    });
    expect(summary.runtimeMs).toBeGreaterThanOrEqual(0);
    const text = renderConcepts(report);
    expect(text).toContain("SCENARIO IMPACT");
    expect(text).toContain("9 scenarios simulated");
    expect(text).toContain("packages 3 → 1 (certain)");
    const focused = renderScenarioImpacts(
      impactsOf("Shifted"),
      report.recenteringCandidates.scenarios.findings.find(
        (item) => item.subject.name === "Shifted"
      )
    );
    expect(focused).toContain("B. semantic center → @l/store");
    expect(focused).toContain("Δ semantic-center-change");
    expect(focused).toContain("? surface-transition-unspecified");
    expect(renderScenarioImpacts(undefined)).toContain("no impact");
    const json = JSON.stringify(report.recenteringCandidates.impacts);
    for (const word of [
      "filesToMove",
      "importsToRewrite",
      "operations",
      "steps",
      "recommended",
      "preferred",
      "winner",
      "rank",
      "score",
    ]) {
      expect(json).not.toContain(word);
    }
  });
});

describe("architecture review", () => {
  function reviewOf(name: string): ArchitecturalScenarioReview {
    const found = report.recenteringCandidates.reviews.reviews.find(
      (item) => item.concept.name === name
    );
    if (!found) {
      throw new Error(`review not found: ${name}`);
    }
    return found;
  }

  function reviewed(name: string, kind: string): ReviewedScenario {
    const found = reviewOf(name).scenarios.find((item) => item.kind === kind);
    if (!found) {
      throw new Error(`no ${kind} review for ${name}`);
    }
    return found;
  }

  it("reviews every V8.3 finding under the same scenario ids", () => {
    const impactIds = report.recenteringCandidates.impacts.findings.map(
      (finding) => finding.scenarios.map((item) => item.scenarioId)
    );
    const reviewIds = report.recenteringCandidates.reviews.reviews.map(
      (review) => review.scenarios.map((item) => item.scenarioId)
    );
    expect(reviewIds).toEqual(impactIds);
    expect(report.recenteringCandidates.reviews.summary).toMatchObject({
      credibleAlternative: 0,
      dominated: 1,
      dominatedBaselines: 0,
      findingsReviewed: 3,
      indistinguishable: 1,
      insufficientEvidence: 3,
      insufficientEvidenceScenarios: 4,
      intentBlocked: 0,
      invalid: 0,
      multipleTradeoffs: 0,
      preserveCurrent: 0,
      scenariosReviewed: 9,
      viable: 3,
    });
  });

  it("dominates the semantic relocation with the behavior rehome on surface and leaves the finding unresolved", () => {
    const shifted = reviewOf("Shifted");
    expect(shifted.disposition).toBe("insufficient-evidence");
    expect(reviewed("Shifted", "rehome-semantic-center")).toMatchObject({
      character: "relocation",
      effects: ["center-alignment", "boundary-reduction", "surface-relocation"],
      evidenceCompleteness: "partial",
      intentCompatibility: "constrained",
      status: "dominated",
    });
    expect(shifted.dominated).toEqual([
      {
        dimensions: ["surface", "intent"],
        dominatedBy: reviewed("Shifted", "rehome-behavior").scenarioId,
        evidence: [
          "surface: package-public contract stays in @l/core; package-public contract relocates @l/core → @l/store (certain)",
          "intent: compatible vs constrained (certain)",
        ],
        scenarioId: reviewed("Shifted", "rehome-semantic-center").scenarioId,
      },
    ]);
    expect(reviewed("Shifted", "rehome-behavior").status).toBe(
      "insufficient-evidence"
    );
    expect(shifted.unresolved).toEqual([
      {
        detail: "differs from the baseline only through boundary (conditional)",
        kind: "conditional-evidence-only",
        scenarioIds: [reviewed("Shifted", "rehome-behavior").scenarioId],
      },
    ]);
    expect(shifted.viable).toEqual([shifted.baselineScenarioId]);
  });

  it("groups consolidations with the same consequences and names the unmeasured edge", () => {
    const split = reviewOf("Split");
    expect(split.disposition).toBe("insufficient-evidence");
    expect(split.scenarios.map((item) => item.status)).toEqual([
      "baseline",
      "insufficient-evidence",
      "insufficient-evidence",
      "indistinguishable",
    ]);
    expect(split.unresolved.map((row) => row.kind)).toEqual([
      "partial-simulation",
      "indistinguishable-scenarios",
    ]);
    expect(split.unresolved[0]?.detail).toBe(
      "unmeasured edge @l/app → @l/store"
    );
    expect(split.unresolved[1]?.detail).toContain(
      "differ only in which package holds the responsibility"
    );
    const coreId = report.recenteringCandidates.scenarios.findings
      .find((finding) => finding.subject.name === "Split")
      ?.scenarios.find(
        (item) =>
          item.kind === "consolidate-behavior" &&
          item.proposed.responsibilities.some(
            (row) =>
              row.responsibility === "domain-behavior" &&
              row.packages.join() === "@l/core"
          )
      )?.id;
    const core = split.scenarios.find((item) => item.scenarioId === coreId);
    expect(core?.character).toBe("structural-reduction");
    expect(core?.strengths.map((row) => row.dimension)).toEqual([
      "boundary",
      "locality",
      "behavior",
    ]);
  });

  it("renders the review section and the focused view", () => {
    const text = renderConcepts(report);
    expect(text).toContain("ARCHITECTURE REVIEW");
    expect(text).toContain("3 findings reviewed");
    expect(text).toContain("Shifted — insufficient-evidence");
    const focused = renderArchitecturalReview(
      reviewOf("Shifted"),
      report.recenteringCandidates.scenarios.findings.find(
        (item) => item.subject.name === "Shifted"
      )
    );
    expect(focused).toContain("B. semantic center → @l/store — dominated");
    expect(focused).toContain("Review  insufficient-evidence");
    expect(focused).toContain("? conditional-evidence-only");
    expect(renderArchitecturalReview(undefined)).toContain("no review");
  });
});
