import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";

import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { renderConceptFamily, renderConcepts } from "../../src/lib/report";
import type {
  ConceptOwnershipAnalysis,
  SurfaceReport,
} from "../../src/lib/types";

const root = path.join(import.meta.dirname, "fixtures", "ownership");
const now = new Date("2027-01-01T00:00:00Z");

let report: SurfaceReport;

function ownership(name: string): ConceptOwnershipAnalysis {
  const found = report.conceptOwnership.concepts.find(
    (item) => item.concept.name === name
  );
  if (!found) {
    throw new Error(`ownership analysis not found: ${name}`);
  }
  return found;
}

function kinds(analysis: ConceptOwnershipAnalysis): string[] {
  return analysis.tensions.map((tension) => tension.kind);
}

beforeAll(async () => {
  report = await analyzeSurface({
    now,
    root,
    target: "packages/a",
    tsconfig: "tsconfig.json",
  });
});

describe("centers", () => {
  it("aligns a concept whose seed, representations, behavior, and references share a package", () => {
    const ticket = ownership("Ticket");
    expect(ticket.alignment).toBe("aligned");
    expect(ticket.center).toEqual({
      behavior: "@w/a",
      implementations: [],
      representation: "@w/a",
      semantic: "@w/a",
      usage: "@w/a",
    });
    expect(ticket.tensions).toEqual([]);
    expect(ticket.behavior.byPackage).toEqual([
      {
        constructors: 0,
        contract: 3,
        functions: 3,
        implementation: 0,
        kinds: { source: { contract: 3, implementation: 0 } },
        methods: 0,
        package: "@w/a",
        share: 1,
      },
    ]);
  });

  it("reads split implementations as distributed, not divergent", () => {
    const store = ownership("Store");
    expect(store.alignment).toBe("distributed");
    expect(store.center.semantic).toBe("@w/a");
    expect(store.center.implementations).toEqual(["@w/a", "@w/b"]);
    expect(store.center.usage).toBe("@w/a");
    expect(kinds(store)).toEqual([]);
    expect(store.candidates.map((item) => item.package)).toEqual([
      "@w/a",
      "@w/b",
      "@w/c",
    ]);
    const a = store.candidates[0];
    expect(a?.roles).toEqual([
      "semantic-center",
      "implementation-center",
      "usage-center",
      "representation-center",
    ]);
    expect(a?.evidence).toContainEqual({
      dimension: "declaration",
      metric: "seed",
      package: "@w/a",
      value: true,
    });
  });

  it("flags seed-vs-behavior when explicit behavior lives elsewhere", () => {
    const signal = ownership("Signal");
    expect(signal.alignment).toBe("divergent");
    expect(signal.center.behavior).toBe("@w/b");
    expect(kinds(signal)).toContain("seed-vs-behavior");
    expect(kinds(signal)).not.toContain("anchor-vs-observed-center");
  });

  it("flags seed-vs-representation when named source representations concentrate elsewhere", () => {
    const shape = ownership("Shape");
    expect(shape.alignment).toBe("divergent");
    expect(shape.center.representation).toBe("@w/b");
    expect(kinds(shape)).toEqual([
      "seed-vs-representation",
      "usage-vs-semantic-center",
    ]);
    expect(shape.behavior.total).toBe(0);
  });

  it("lets the usage center differ without divergence", () => {
    const label = ownership("Label");
    expect(label.center.usage).toBe("@w/b");
    expect(label.center.semantic).toBe("@w/a");
    expect(label.center.behavior).toBe("@w/a");
    expect(label.center.representation).toBe("@w/a");
    expect(kinds(label)).toEqual(["usage-vs-semantic-center"]);
    expect(label.alignment).toBe("distributed");
  });
});

describe("file kinds", () => {
  it("keeps test behavior visible in another package without moving the behavior center", () => {
    const label = ownership("Label");
    const b = label.behavior.byPackage.find((row) => row.package === "@w/b");
    expect(b).toMatchObject({
      contract: 6,
      implementation: 0,
      kinds: { test: { contract: 6, implementation: 0 } },
    });
    const a = label.behavior.byPackage.find((row) => row.package === "@w/a");
    expect(a?.kinds).toEqual({ source: { contract: 3, implementation: 0 } });
    expect(label.center.behavior).toBe("@w/a");
    expect(kinds(label)).not.toContain("seed-vs-behavior");
    expect(label.alignment).toBe("distributed");
    const candidate = label.candidates.find((item) => item.package === "@w/b");
    expect(candidate?.participation.behaviors).toBe(6);
    expect(candidate?.evidence).toContainEqual({
      dimension: "behavior",
      metric: "contractShare",
      package: "@w/b",
      value: 6 / 9,
    });
    expect(
      label.candidates
        .find((item) => item.package === "@w/a")
        ?.evidence.find((item) => item.metric === "sourceContractShare")?.value
    ).toBe(1);
  });

  it("keeps a test-heavy representation spread visible without making it the center", () => {
    const shape = ownership("Shape");
    expect(shape.representationKinds).toEqual([
      { kinds: { source: 1 }, package: "@w/a" },
      { kinds: { source: 9 }, package: "@w/b" },
      { kinds: { test: 12 }, package: "@w/c" },
    ]);
    const c = shape.candidates.find((item) => item.package === "@w/c");
    expect(c?.participation.representations).toBe(12);
    expect(c?.evidence).toContainEqual({
      dimension: "representation",
      metric: "share",
      package: "@w/c",
      value: 12 / 22,
    });
    expect(shape.center.representation).toBe("@w/b");
    expect(
      shape.tensions.find(
        (tension) => tension.kind === "seed-vs-representation"
      )
    ).toEqual({
      kind: "seed-vs-representation",
      observedPackage: "@w/b",
      seedPackage: "@w/a",
      value: 0.9,
    });
  });
});

describe("aggregators", () => {
  it("reads an import-then-export module as an aggregator", () => {
    const forward = report.dependencyGravity.modules.find(
      (module) => module.node.id === "packages/a/src/forward.ts"
    );
    expect(forward?.role).toEqual({
      entrypoint: false,
      kind: "aggregator",
      ownDeclarations: 0,
      reExports: 1,
    });
  });

  it("never lets a barrel become a representation", () => {
    const ticket = report.conceptInventory.families.find(
      (family) => family.seed.name === "Ticket"
    );
    expect(ticket?.representations.map((item) => item.file)).not.toContain(
      "packages/a/src/forward.ts"
    );
    expect(ticket?.distribution.modules).not.toContain(
      "packages/a/src/forward.ts"
    );
    expect(ownership("Ticket").alignment).toBe("aligned");
  });
});

describe("boundaries and support", () => {
  it("explains a stored representation through a conversion boundary, not a tension", () => {
    const observation = ownership("Observation");
    expect(observation.center.semantic).toBe("@w/a");
    expect(observation.alignment).not.toBe("divergent");
    const [boundary] = observation.overlap;
    expect(observation.overlap).toHaveLength(1);
    expect(boundary?.other.name).toBe("StoredObservation");
    expect(boundary?.other.package).toBe("@w/b");
    expect(boundary?.other.inTarget).toBe(false);
    expect(boundary?.conversionPackages).toEqual(["@w/b"]);
    expect(boundary?.representationBoundary).toBe(true);
    const b = observation.candidates.find((item) => item.package === "@w/b");
    expect(b?.participation.conversions).toBe(2);
    expect(b?.dimensions).toContain("conversion");
  });

  it("warns about missing implementations only for method-bearing interfaces", () => {
    const kindsOf = (name: string) =>
      ownership(name).cautions.map((caution) => caution.kind);
    expect(kindsOf("Ticket")).not.toContain("no-implementation-evidence");
    expect(kindsOf("Store")).not.toContain("no-implementation-evidence");
  });

  it("returns insufficient evidence for a tiny family", () => {
    const tiny = ownership("Tiny");
    expect(tiny.alignment).toBe("insufficient-evidence");
    expect(tiny.center).toEqual({ implementations: [] });
    expect(tiny.tensions).toEqual([]);
    expect(tiny.candidates.map((item) => item.package)).toEqual(["@w/a"]);
  });

  it("keeps overlapping in-target concepts as separate analyses", () => {
    const snapshot = ownership("Snapshot");
    const record = ownership("SnapshotRecord");
    expect(snapshot.concept.id).not.toBe(record.concept.id);
    expect(snapshot.overlap.map((item) => item.other.name)).toEqual([
      "SnapshotRecord",
    ]);
    expect(record.overlap.map((item) => item.other.name)).toEqual(["Snapshot"]);
    expect(report.conceptInventory.families.map((f) => f.seed.name)).toContain(
      "SnapshotRecord"
    );
  });
});

describe("behavior attribution", () => {
  it("counts members of implementing classes and nothing from unrelated classes", () => {
    const store = ownership("Store");
    const b = store.behavior.byPackage.find((row) => row.package === "@w/b");
    expect(b?.share).toBeCloseTo(4 / 11);
    expect({ ...b, share: 0 }).toEqual({
      constructors: 0,
      contract: 1,
      functions: 1,
      implementation: 3,
      kinds: { source: { contract: 1, implementation: 3 } },
      methods: 3,
      package: "@w/b",
      share: 0,
    });
    const a = store.behavior.byPackage.find((row) => row.package === "@w/a");
    expect(a?.implementation).toBe(3);
    expect(a?.contract).toBe(2);
  });
});

describe("history and anchors", () => {
  it("infers no evolution center from files without history", () => {
    const store = ownership("Store");
    expect(store.evolution?.every((row) => row.strongCouplingPairs === 0)).toBe(
      true
    );
    expect(store.center.evolution).toBeUndefined();
    expect(store.cautions.map((caution) => caution.kind)).toContain(
      "sparse-history"
    );
    expect(store.tensions.map((tension) => tension.kind)).not.toContain(
      "seed-vs-evolution"
    );
  });

  it("surfaces anchor-vs-observed-center with the anchor reason preserved", async () => {
    const anchored = await analyzeSurface({
      config: {
        ...ANALYSIS_CONFIG,
        anchors: [{ reason: "core domain boundary", target: "@w/a" }],
      },
      now,
      root,
      target: "packages/a",
      tsconfig: "tsconfig.json",
    });
    const find = (name: string) =>
      anchored.conceptOwnership.concepts.find(
        (item) => item.concept.name === name
      );
    // Representations and behavior both center on b: the anchor is questioned.
    const signal = find("Signal");
    expect(signal?.tensions.at(-1)).toEqual({
      kind: "anchor-vs-observed-center",
      observedPackage: "@w/b",
      seedPackage: "@w/a",
      value: 2,
    });
    expect(signal?.cautions).toContainEqual({
      detail: "core domain boundary",
      kind: "anchored-seed",
    });
    expect(signal?.alignment).toBe("divergent");
    // One diverging dimension questions the seed, not the anchor.
    const shape = find("Shape");
    expect(shape?.alignment).toBe("divergent");
    expect(shape?.tensions.map((tension) => tension.kind)).not.toContain(
      "anchor-vs-observed-center"
    );
    // References elsewhere alone never question the anchor.
    const label = find("Label");
    expect(label?.tensions.map((tension) => tension.kind)).toEqual([
      "usage-vs-semantic-center",
    ]);
    expect(find("Ticket")?.tensions).toEqual([]);
  });
});

describe("report", () => {
  it("summarizes without declaring an owner", () => {
    expect(report.schemaVersion).toBe(35);
    expect(report.conceptOwnership.summary).toEqual({
      aligned: 2,
      analyzed: 11,
      distributed: 2,
      divergent: 2,
      insufficientEvidence: 5,
      tensions: 6,
    });
    expect(JSON.stringify(report.conceptOwnership)).not.toContain('"owner"');
  });

  it("renders the ownership section and the focused view", () => {
    const text = renderConcepts(report);
    expect(text).toContain("CONCEPT OWNERSHIP");
    expect(text).toContain("Signal");
    const family = report.conceptInventory.families.find(
      (item) => item.seed.name === "Observation"
    );
    if (!family) {
      throw new Error("Observation family missing");
    }
    const single = renderConceptFamily(
      family,
      undefined,
      report.conceptOverlap,
      report.conceptOwnership
    );
    expect(single).toContain("OWNERSHIP");
    expect(single).toContain("semantic center    @w/a");
    expect(single).toContain("representation boundaries");
    expect(single).toContain("StoredObservation");
    expect(single).not.toContain("owner ");
  });
});
