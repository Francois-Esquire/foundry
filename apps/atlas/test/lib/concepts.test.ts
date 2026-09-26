import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import type { ConceptFamily, SurfaceReport } from "../../src/lib/types";

const root = path.join(import.meta.dirname, "fixtures", "concepts");
const now = new Date("2027-01-01T00:00:00Z");

let report: SurfaceReport;

function family(name: string): ConceptFamily {
  const found = report.conceptInventory.families.find(
    (candidate) => candidate.seed.name === name
  );
  if (!found) {
    throw new Error(`family not found: ${name}`);
  }
  return found;
}

function representations(
  name: string,
  relationship: ConceptFamily["representations"][number]["relationship"]
): string[] {
  return family(name)
    .representations.filter((item) => item.relationship === relationship)
    .map((item) => `${item.name}@${item.package}`)
    .sort();
}

beforeAll(async () => {
  report = await analyzeSurface({
    now,
    root,
    target: "packages/core",
    tsconfig: "tsconfig.json",
  });
});

describe("seeds", () => {
  it("seeds every type-like declaration in the target, exported or not", () => {
    const names = report.conceptInventory.families
      .map((item) => item.seed.name)
      .sort();
    expect(names).toEqual(
      [
        "BaseStore",
        "CachedStore",
        "LocalOnly",
        "MemoryStore",
        "Shape",
        "Status",
        "StoreOptions",
        "Tree",
        "WorkspaceId",
        "WorkspaceIdentifier",
        "Store",
      ].sort()
    );
    expect(report.conceptInventory.summary.seeds).toBe(11);
  });

  it("never seeds functions, constants, stdlib types, or anonymous shapes", () => {
    const names = report.conceptInventory.families.map(
      (item) => item.seed.name
    );
    expect(names).not.toContain("createStore");
    expect(names).not.toContain("Promise");
    expect(names).not.toContain("Array");
  });

  it("keeps a primitive alias as a seed", () => {
    expect(family("WorkspaceId").seed.kind).toBe("type");
  });

  it("records declaration location and surface facts separately", () => {
    const { seed } = family("Store");
    expect(seed.declaration).toEqual({
      file: "packages/core/src/store.ts",
      package: "@c/core",
    });
    expect(seed.surface).toEqual({
      externallyUsed: true,
      moduleExported: true,
      packagePublic: true,
    });
    expect(family("LocalOnly").seed.surface).toEqual({
      externallyUsed: false,
      moduleExported: false,
      packagePublic: false,
    });
  });

  it("keeps same-named types in different packages separate", () => {
    const statuses = report.conceptInventory.families.filter(
      (item) => item.seed.name === "Status"
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.distribution).toMatchObject({
      moduleCount: 1,
      packageCount: 1,
      references: 0,
    });
  });

  it("does not add a seed or evidence for re-exports", () => {
    const ids = report.conceptInventory.families.filter(
      (item) => item.seed.name === "WorkspaceId"
    );
    expect(ids).toHaveLength(1);
    expect(ids[0]?.distribution.modules).not.toContain(
      "packages/core/src/barrel.ts"
    );
    expect(ids[0]?.distribution.modules).not.toContain(
      "packages/core/src/index.ts"
    );
  });
});

describe("relationships", () => {
  it("collects implementations across packages", () => {
    expect(representations("Store", "implementation")).toEqual([
      "BaseStore@@c/core",
      "SqliteStore@@c/impl",
    ]);
    expect(family("Store").relationships.implements).toBe(2);
  });

  it("collects interface and class extension with direction preserved", () => {
    expect(representations("Store", "extension")).toEqual([
      "CachedStore@@c/core",
    ]);
    expect(representations("BaseStore", "extension")).toEqual([
      "MemoryStore@@c/core",
    ]);
    expect(family("CachedStore").relationships.extends).toBe(0);
  });

  it("records a bare type alias without collapsing identities", () => {
    expect(representations("WorkspaceId", "alias")).toEqual([
      "WorkspaceIdentifier@@c/core",
    ]);
    expect(family("WorkspaceIdentifier").distribution.references).toBe(0);
  });

  it("records parameter, return, and property types", () => {
    const store = family("Store");
    expect(store.relationships["parameter-type"]).toBe(1);
    expect(store.relationships["return-type"]).toBe(1);
    expect(store.relationships["property-type"]).toBe(1);
    expect(representations("Store", "factory")).toEqual([
      "createStore@@c/core",
    ]);
    expect(representations("Store", "type-user")).toEqual([
      "StoreOptions@@c/core",
      "run@@c/impl",
    ]);
  });

  it("sees through generic wrappers and import aliases", () => {
    const id = family("WorkspaceId");
    // load(id: WorkspaceId): Promise<WorkspaceId>, run(ids: Array<WorkspaceId>), handler(id: Wid): Wid
    expect(id.relationships["parameter-type"]).toBe(3);
    expect(id.relationships["return-type"]).toBe(2);
    expect(representations("WorkspaceId", "type-user").sort()).toEqual([
      "handler@@c/impl",
      "load@@c/core",
      "run@@c/impl",
    ]);
  });

  it("records constructions", () => {
    expect(family("MemoryStore").relationships.constructs).toBe(2);
    expect(representations("MemoryStore", "other")).toEqual([
      "createStore@@c/core",
      "run@@c/impl",
    ]);
  });

  it("ignores self-references", () => {
    expect(family("Tree").distribution.references).toBe(0);
    expect(family("Tree").evidence).toHaveLength(1);
  });
});

describe("distribution", () => {
  it("stays local for a concept used only in its own module", () => {
    expect(family("LocalOnly").distribution).toEqual({
      moduleCount: 1,
      modules: ["packages/core/src/store.ts"],
      packageCount: 1,
      packagePublicRepresentations: 1,
      packages: ["@c/core"],
      references: 1,
    });
  });

  it("counts exact packages and modules for a distributed concept", () => {
    expect(family("WorkspaceId").distribution).toEqual({
      moduleCount: 2,
      modules: ["packages/core/src/ids.ts", "packages/impl/src/index.ts"],
      packageCount: 2,
      // WorkspaceIdentifier (alias), load (type-user), load (factory)
      packagePublicRepresentations: 3,
      packages: ["@c/core", "@c/impl"],
      references: 6,
    });
  });

  it("only assesses package-public representations inside the target", () => {
    // BaseStore, CachedStore, StoreOptions, createStore are public; SqliteStore and run are foreign.
    expect(family("Store").distribution.packagePublicRepresentations).toBe(4);
  });

  it("summarizes distributed and cross-package families", () => {
    expect(report.conceptInventory.summary).toEqual({
      aliases: 1,
      crossPackageFamilies: 3,
      distributedFamilies: 3,
      families: 11,
      implementations: 2,
      seeds: 11,
    });
  });

  it("ranks families by package, module, then reference spread", () => {
    const order = report.conceptInventory.families
      .slice(0, 3)
      .map((item) => item.seed.name);
    // Store and WorkspaceId tie on 2 packages, 2 modules, 6 references; name breaks it.
    expect(order).toEqual(["Store", "WorkspaceId", "MemoryStore"]);
  });
});

describe("evidence", () => {
  it("explains each relationship with source, file, and line", () => {
    const evidence = family("Store").evidence.find(
      (item) => item.kind === "implements" && item.package === "@c/impl"
    );
    expect(evidence).toEqual({
      file: "packages/impl/src/index.ts",
      kind: "implements",
      line: 5,
      package: "@c/impl",
      source: {
        kind: "class",
        name: "SqliteStore",
        symbolId: "packages/impl/src/index.ts#SqliteStore",
      },
      target: "packages/core/src/store.ts#Store",
    });
  });
});

describe("distribution analysis", () => {
  it("attaches an analysis to every family", () => {
    for (const item of report.conceptInventory.families) {
      expect(item.distributionAnalysis?.seed.id).toBe(item.seed.id);
    }
    expect(report.conceptInventory.distribution).toEqual({
      crossPackage: 3,
      families: 11,
      implementationSplit: 1,
      local: 8,
      referenceDistributed: 0,
      representationConcentrated: 0,
      temporallyCoupled: 0,
    });
  });

  it("shapes a local family and a split contract", () => {
    expect(family("LocalOnly").distributionAnalysis?.shapes).toEqual(["local"]);
    const store = family("Store").distributionAnalysis;
    expect(store?.shapes).toEqual(["cross-package", "implementation-split"]);
    expect(store?.representations.implementationPackages).toBe(2);
    expect(store?.boundaries).toEqual({
      moduleCount: 2,
      packageSpan: 1,
      referencePackages: ["@c/core", "@c/impl"],
      representationPackages: ["@c/core", "@c/impl"],
      seedPackage: "@c/core",
    });
  });

  it("keeps reference totals equal to the V7.0 count with resolved identity", () => {
    const workspaceId = family("WorkspaceId");
    const references = workspaceId.distributionAnalysis?.references;
    expect(references?.total).toBe(workspaceId.distribution.references);
    expect(references?.byModule.map((entry) => entry.module)).not.toContain(
      "packages/core/src/barrel.ts"
    );
    expect(references?.byPackage).toEqual([
      { modules: 1, package: "@c/core", references: 3, share: 0.5 },
      { modules: 1, package: "@c/impl", references: 3, share: 0.5 },
    ]);
  });
});

describe("report", () => {
  it("bumps the schema version", () => {
    expect(report.schemaVersion).toBe(35);
    expect(report.conceptInventory.target).toBe("@c/core");
  });
});
