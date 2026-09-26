import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { renderConceptFamily, renderConcepts } from "../../src/lib/report";
import type {
  ConceptBehavioralLocality,
  SurfaceReport,
} from "../../src/lib/types";

const root = path.join(import.meta.dirname, "fixtures", "locality");
const now = new Date("2027-01-01T00:00:00Z");

let report: SurfaceReport;

function locality(name: string): ConceptBehavioralLocality {
  const found = report.conceptBehavioralLocality.concepts.find(
    (item) => item.concept.name === name
  );
  if (!found) {
    throw new Error(`locality analysis not found: ${name}`);
  }
  return found;
}

function cautions(item: ConceptBehavioralLocality): string[] {
  return item.cautions.map((caution) => caution.kind);
}

beforeAll(async () => {
  report = await analyzeSurface({
    now,
    root,
    target: "packages/core",
    tsconfig: "tsconfig.json",
  });
});

describe("shapes", () => {
  it("reads behavior in one module as local", () => {
    const local = locality("Local");
    expect(local.shape).toEqual({ modifiers: [], primary: "local" });
    expect(local.behavior.source).toBe(3);
    expect(local.span).toEqual({
      boundaryEdges: [],
      moduleCount: 1,
      packageBoundaryCount: 0,
      packageCount: 1,
      sourceModuleCount: 1,
      sourcePackageCount: 1,
    });
    expect(local.traversal.moduleDistances).toEqual([]);
    expect(local.cautions).toEqual([]);
  });

  it("reads behavior across several modules of one package as single-package-distributed", () => {
    const spread = locality("Spread");
    expect(spread.shape.primary).toBe("single-package-distributed");
    expect(spread.span.sourceModuleCount).toBe(3);
    expect(spread.span.sourcePackageCount).toBe(1);
    expect(spread.traversal.moduleDistances).toEqual([
      {
        from: "packages/core/src/spread-a.ts",
        inward: 1,
        to: "packages/core/src/spread-b.ts",
        viaAggregator: false,
      },
      {
        from: "packages/core/src/spread-a.ts",
        inward: 1,
        to: "packages/core/src/spread-c.ts",
        viaAggregator: false,
      },
    ]);
    expect(spread.traversal.disconnectedModules).toBe(0);
  });

  it("reads a domain/persistence split with converters as cross-package-localized", () => {
    const domain = locality("Domain");
    expect(domain.shape).toEqual({
      modifiers: [],
      primary: "cross-package-localized",
    });
    expect(domain.span.boundaryEdges).toEqual([
      { from: "@l/store", to: "@l/core" },
    ]);
    expect(domain.changeSurface).toEqual({
      converterModules: 1,
      hotspotModules: 0,
      implementationModules: 0,
      packages: 2,
      sourceModules: 2,
      stronglyCoupledBehaviorModules: 0,
    });
    const convert = domain.behavior.byModule.find(
      (row) => row.module === "packages/store/src/convert.ts"
    );
    expect(convert).toMatchObject({
      behaviors: 2,
      contractBehaviors: 2,
      conversionBehaviors: 2,
    });
    expect(domain.behavior.total).toBe(3);
  });

  it("reads three packages, six modules, and a two-step path as cross-package-distributed", () => {
    const wide = locality("Wide");
    expect(wide.shape.primary).toBe("cross-package-distributed");
    expect(wide.span.sourceModuleCount).toBe(6);
    expect(wide.span.sourcePackageCount).toBe(3);
    expect(wide.span.boundaryEdges).toEqual([
      { from: "@l/app", to: "@l/store" },
      { from: "@l/store", to: "@l/core" },
    ]);
    expect(wide.traversal.centerDistances).toEqual([
      { from: "@l/core", inward: 2, to: "@l/app" },
      { from: "@l/core", inward: 1, to: "@l/store" },
    ]);
    expect(wide.traversal.maxModuleDistance).toBe(3);
    expect(wide.traversal.disconnectedPackagePairs).toBe(0);
  });

  it("marks implementations in two packages as parallel-implementations", () => {
    const repo = locality("Repo");
    expect(repo.shape).toEqual({
      modifiers: ["parallel-implementations"],
      primary: "cross-package-localized",
    });
    expect(repo.changeSurface.implementationModules).toBe(2);
    expect(
      repo.behavior.byPackage.map((row) => [
        row.package,
        row.implementationBehaviors,
      ])
    ).toEqual([
      ["@l/core", 2],
      ["@l/store", 2],
    ]);
  });

  it("reads a broadly referenced type with one factory as behavior-light", () => {
    const token = locality("Token");
    expect(token.shape.primary).toBe("behavior-light");
    expect(token.behavior.source).toBe(1);
    expect(token.halo).toEqual({ modules: 6, packages: 5, references: 6 });
  });

  it("returns insufficient evidence without forcing a shape", () => {
    const box = locality("CoreTokenBox");
    expect(box.shape.primary).toBe("insufficient-evidence");
    expect(box.behavior.total).toBe(0);
  });
});

describe("file kinds", () => {
  it("keeps test helpers out of the primary shape but visible", () => {
    const helper = locality("Helper");
    expect(helper.shape.primary).toBe("local");
    expect(helper.behavior).toMatchObject({ source: 2, test: 10, total: 12 });
    expect(helper.span).toMatchObject({
      moduleCount: 2,
      packageCount: 2,
      sourceModuleCount: 1,
      sourcePackageCount: 1,
    });
    expect(cautions(helper)).toContain("test-heavy-behavior");
    const store = helper.behavior.byPackage.find(
      (row) => row.package === "@l/store"
    );
    expect(store).toMatchObject({
      behaviors: 10,
      sourceBehaviors: 0,
      testBehaviors: 10,
    });
  });

  it("keeps story behavior out of the primary shape", () => {
    const card = locality("Card");
    expect(card.shape.primary).toBe("local");
    expect(card.behavior).toMatchObject({ source: 1, story: 3 });
    expect(cautions(card)).toEqual(["test-heavy-behavior"]);
  });
});

describe("traversal", () => {
  it("measures the shortest directed path and records aggregators on it", () => {
    const repo = locality("Repo");
    expect(repo.traversal.origin).toEqual({
      module: "packages/core/src/repo.ts",
      package: "@l/core",
    });
    expect(repo.traversal.moduleDistances).toEqual([
      {
        from: "packages/core/src/repo.ts",
        inward: 1,
        to: "packages/core/src/memory-repo.ts",
        viaAggregator: false,
      },
      {
        from: "packages/core/src/repo.ts",
        inward: 2,
        to: "packages/store/src/sql-repo.ts",
        viaAggregator: true,
      },
    ]);
    expect(repo.traversal.centerDistances).toEqual([
      { from: "@l/core", inward: 1, to: "@l/store" },
    ]);
  });

  it("never counts a barrel as a behavioral module", () => {
    const modules = report.conceptBehavioralLocality.concepts.flatMap((item) =>
      item.behavior.byModule.map((row) => row.module)
    );
    expect(modules).not.toContain("packages/core/src/index.ts");
    expect(modules).not.toContain("packages/store/src/index.ts");
    expect(modules).not.toContain("packages/app/src/index.ts");
  });

  it("keeps two implementation packages that never reach each other as disconnected", () => {
    const plugin = locality("Plugin");
    expect(plugin.shape.modifiers).toEqual(["parallel-implementations"]);
    expect(plugin.traversal.packageDistances).toEqual([
      { from: "@l/plug-a", to: "@l/plug-b" },
    ]);
    expect(plugin.traversal.disconnectedPackagePairs).toBe(1);
    expect(plugin.traversal.disconnectedModules).toBe(0);
    expect(cautions(plugin)).toContain("disconnected-static-path");
    expect(cautions(plugin)).toContain("target-scoped-history");
  });
});

describe("independence", () => {
  it("does not let reference breadth inflate locality", () => {
    const helper = locality("Helper");
    expect(helper.halo.references).toBeGreaterThan(helper.behavior.source);
    expect(helper.shape.primary).toBe("local");
  });

  it("leaves families and ownership untouched", () => {
    expect(
      report.conceptInventory.families.map((family) => family.seed.name)
    ).toContain("Domain");
    expect(
      report.conceptInventory.families.map((family) => family.seed.name)
    ).not.toContain("StoredDomain");
    const ownership = report.conceptOwnership.concepts.find(
      (item) => item.concept.name === "Repo"
    );
    expect(ownership?.alignment).toBe("distributed");
    expect(ownership?.behavior.participants).toHaveLength(5);
    expect(JSON.stringify(report.conceptBehavioralLocality)).not.toContain(
      "opportunit"
    );
  });
});

describe("report", () => {
  it("summarizes shapes and modifiers", () => {
    expect(report.schemaVersion).toBe(35);
    expect(report.conceptBehavioralLocality.summary).toEqual({
      analyzed: 20,
      behaviorLight: 1,
      crossPackageDistributed: 2,
      crossPackageLocalized: 5,
      insufficientEvidence: 7,
      local: 4,
      parallelImplementations: 3,
      singlePackageDistributed: 1,
    });
  });

  it("renders the section and the focused view", () => {
    const text = renderConcepts(report);
    expect(text).toContain("BEHAVIORAL LOCALITY");
    expect(text).toContain("Wide");
    const family = report.conceptInventory.families.find(
      (item) => item.seed.name === "Repo"
    );
    if (!family) {
      throw new Error("Repo family missing");
    }
    const single = renderConceptFamily(
      family,
      undefined,
      report.conceptOverlap,
      report.conceptOwnership,
      report.conceptBehavioralLocality
    );
    expect(single).toContain(
      "shape              cross-package-localized · parallel-implementations"
    );
    expect(single).toContain("@l/store → @l/core distance 1");
    expect(single).toContain("via aggregator");
    expect(single).not.toContain("score");
  });
});
