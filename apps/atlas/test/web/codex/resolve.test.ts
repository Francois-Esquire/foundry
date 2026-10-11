import { describe, expect, it } from "vitest";
import {
  pairEndpoints,
  resolveCodex,
  resolveLateCodex,
} from "../../../src/web/codex/resolve";
import type {
  CodexSource,
  LateCodexSource,
} from "../../../src/web/codex/source";
import { loadAtlas } from "../../helpers/reference-atlas";

const coreRoles = [
  {
    fanIn: 4,
    highFanIn: true,
    module: "packages/core/src/a.ts",
    role: "junction" as const,
  },
  { fanIn: 0, highFanIn: false, module: "packages/core/src/b.test.ts" },
];

const coreGroup = {
  anchor: "responsibility:a",
  anchorModule: "packages/core/src/a.ts",
  anchorWeight: 2,
  id: "responsibility-group:0123456789ab",
  label: "a",
  modules: ["packages/core/src/a.ts"],
  responsibilities: ["responsibility:a", "responsibility:c"],
};

const source: CodexSource = {
  dataset: { coverage: "partial", generatedAt: "2026-09-23T00:00:00.000Z" },
  declaredDependencies: [
    {
      declared: {
        dependencies: { "@foundry/core": "workspace:*", react: "^19" },
        devDependencies: { "@foundry/ui": "workspace:*" },
        peerDependencies: { "@foundry/core": "workspace:*" },
      },
      package: "@foundry/ui",
    },
    { declared: {}, package: "@foundry/core" },
  ],
  dependencies: [
    {
      concepts: { total: 2 },
      dependency: { moduleEdges: 1 },
      from: "@foundry/ui",
      to: "@foundry/core",
    },
  ],
  // The manifest lists ui only, as no real one would: core's folder is empty.
  domains: {
    domains: [
      {
        name: "shapes",
        parents: [],
        places: [{ kind: "folder", place: "packages/core/src" }],
        unmatched: [],
      },
    ],
    placements: [
      {
        away: { shared: 1, total: 2, unindexed: 0 },
        domainLabel: "departs",
        domains: ["shapes"],
        level: "file",
        package: "@foundry/core",
        place: "packages/core/src/a.ts",
        placementLabel: "departs",
        sharedDomains: ["shapes"],
      },
    ],
  },
  fileRoles: [
    {
      highFanInCutoff: 3,
      id: "@foundry/core",
      modules: coreRoles,
    },
  ],
  history: {
    packages: [
      { checkpoints: ["old", "new", "failed"], id: "@foundry/former" },
      { checkpoints: ["old"], id: "@foundry/core" },
      { checkpoints: ["failed"], id: "@foundry/unfinished" },
      { checkpoints: ["old"], id: "@foundry/early" },
    ],
    snapshots: [
      { commit: "old", status: "complete", timestamp: "2026-01-01" },
      { commit: "new", status: "complete", timestamp: "2026-03-01" },
      { commit: "failed", status: "failed", timestamp: "2026-04-01" },
    ],
  },
  imports: [
    { source: "packages/core/src/b.test.ts", target: "packages/core/src/a.ts" },
    { source: "packages/ui/index.ts", target: "packages/core/src/a.ts" },
  ],
  modules: [
    {
      fileKind: "source",
      id: "packages/core/src/a.ts",
      package: "@foundry/core",
      path: "packages/core/src/a.ts",
    },
    {
      fileKind: "test",
      id: "packages/core/src/b.test.ts",
      package: "@foundry/core",
      path: "packages/core/src/b.test.ts",
    },
    {
      id: "packages/ui/index.ts",
      package: "@foundry/ui",
      path: "packages/ui/index.ts",
    },
  ],
  packagePaths: [{ id: "@foundry/ui", path: "packages/ui" }],
  packages: [
    {
      analyzed: false,
      id: "@foundry/core",
      layer: null,
      modules: { total: 2 },
    },
    {
      analyzed: true,
      id: "@foundry/ui",
      layer: 1,
      modules: { total: 1 },
    },
  ],
  placement: {
    packages: [{ id: "@foundry/core" }],
    places: [
      {
        away: [
          {
            modules: ["packages/ui/a.ts", "packages/ui/b.ts"],
            package: "@foundry/ui",
          },
        ],
        home: { modules: ["packages/core/src/b.ts"] },
        label: "departs",
        level: "file",
        package: "@foundry/core",
        place: "packages/core/src/a.ts",
        toward: "@foundry/ui",
        unindexed: 1,
      },
      {
        away: [{ modules: ["packages/ui/a.ts"], package: "@foundry/ui" }],
        home: { modules: ["packages/core/src/a.ts", "packages/core/src/c.ts"] },
        label: "fits",
        level: "symbol",
        package: "@foundry/core",
        place: "packages/core/src/b.ts#b",
        unindexed: 0,
      },
    ],
    policy: { dominantShare: 0.6 },
  },
  responsibilityGroups: [
    {
      groups: [coreGroup],
      id: "@foundry/core",
      independent: ["responsibility:b"],
    },
  ],
};

/** The readings read after the layout. */
const late: LateCodexSource = {
  nesting: {
    folders: [
      {
        fileCounts: { descendant: 2, direct: 0 },
        id: "packages/core",
        package: "@foundry/core",
        packageRoot: true,
      },
    ],
    pathRegions: [],
    seams: [],
  },
  proximity: {
    apart: {
      coChanges: [
        {
          coChangeCommits: 3,
          distance: 2,
          id: "packages/core/src/a.ts|packages/core/lib/c.ts",
          jaccard: 0.5,
          left: "packages/core/src/a.ts",
          right: "packages/core/lib/c.ts",
          scope: "same-package",
          staticPath: "none",
        },
      ],
      files: [],
    },
    close: [],
    packages: [{ id: "@foundry/core", unresolved: 0 }],
  },
};

describe("resolveCodex", () => {
  const codex = resolveCodex(source);

  it("carries the survey time and coverage", () => {
    expect(codex.workspace).toEqual({
      coverage: "partial",
      surveyedAt: "2026-09-23T00:00:00.000Z",
    });
  });

  it("sizes packages from the package-sizes lens, names them without their scope, keeps an unplaced layer unplaced, takes their folders from the manifest, and keeps their lens entries", () => {
    expect(codex.packages).toEqual([
      {
        analyzed: false,
        fileRoles: { modules: coreRoles },
        highFanInCutoff: 3,
        id: "@foundry/core",
        label: "core",
        layer: null,
        path: "",
        responsibilityGroups: {
          groups: [coreGroup],
          independent: ["responsibility:b"],
        },
        size: 2,
      },
      {
        analyzed: true,
        fileRoles: undefined,
        highFanInCutoff: 0,
        id: "@foundry/ui",
        label: "ui",
        layer: 1,
        path: "packages/ui",
        responsibilityGroups: undefined,
        size: 1,
      },
    ]);
  });

  it("counts each place's consumer modules and gives its dominance share, leaving unindexed consumers out", () => {
    expect(codex.placement).toEqual({
      dominantShare: 0.6,
      labelled: ["@foundry/core"],
      places: [
        {
          away: [{ modules: 2, package: "@foundry/ui" }],
          home: 1,
          label: "departs",
          level: "file",
          package: "@foundry/core",
          place: "packages/core/src/a.ts",
          share: 2 / 3,
          toward: "@foundry/ui",
          unindexed: 1,
        },
        {
          away: [{ modules: 1, package: "@foundry/ui" }],
          home: 2,
          label: "fits",
          level: "symbol",
          package: "@foundry/core",
          place: "packages/core/src/b.ts#b",
          share: 2 / 3,
          unindexed: 0,
        },
      ],
    });
  });

  it("keeps the nesting lens as saved, and keys domain labels as placements are keyed", () => {
    expect(resolveLateCodex(late).nesting).toBe(late.nesting);
    expect(codex.domains.declared).toBe(source.domains.domains);
    expect(Object.keys(codex.domains.placements)).toEqual([
      "file:packages/core/src/a.ts",
    ]);
  });

  it("keeps the proximity lens as saved, with the packages it covered", () => {
    const { proximity } = resolveLateCodex(late);
    expect(proximity.labelled).toEqual(["@foundry/core"]);
    expect(proximity.apart).toBe(late.proximity.apart);
    expect(proximity.close).toEqual([]);
  });

  it("counts module dependents and dependencies across package lines", () => {
    const [a, test, index] = codex.modules;
    expect(a).toMatchObject({ dependencies: 0, dependents: 2 });
    expect(test).toMatchObject({ dependencies: 1, dependents: 0 });
    expect(index).toMatchObject({ dependencies: 1, dependents: 0 });
  });

  it("takes each module's internal fan-in and high fan-in from the file-roles lens, and 0 and false without internals", () => {
    const [a, test, index] = codex.modules;
    expect(a).toMatchObject({ highFanIn: true, internalFanIn: 4 });
    expect(test).toMatchObject({ highFanIn: false, internalFanIn: 0 });
    expect(index).toMatchObject({ highFanIn: false, internalFanIn: 0 });
  });

  it("names module directory and kind", () => {
    expect(codex.modules[0]).toMatchObject({
      directory: "packages/core/src",
      fileKind: "source",
    });
    expect(codex.modules[2]).toMatchObject({
      directory: "packages/ui",
      fileKind: "unknown",
    });
  });

  it("keeps imports and measured dependencies", () => {
    expect(codex.imports).toEqual(source.imports);
    expect(codex.dependencies).toEqual([
      {
        consumerFiles: ["packages/ui/index.ts"],
        from: "@foundry/ui",
        sharedConcepts: 2,
        strength: 1,
        supplierFiles: ["packages/core/src/a.ts"],
        to: "@foundry/core",
      },
    ]);
  });

  it("joins each package pair to the files at both ends of its imports, once, sorted", () => {
    const endpoints = pairEndpoints(
      [
        { source: "ui/b.ts", target: "core/x.ts" },
        { source: "ui/a.ts", target: "core/y.ts" },
        { source: "ui/a.ts", target: "core/x.ts" },
        { source: "ui/a.ts", target: "ui/b.ts" },
        { source: "ui/a.ts", target: "elsewhere.ts" },
        { source: "core/x.ts", target: "ui/a.ts" },
      ],
      new Map([
        ["ui/a.ts", "ui"],
        ["ui/b.ts", "ui"],
        ["core/x.ts", "core"],
        ["core/y.ts", "core"],
      ])
    );
    expect(endpoints("ui", "core")).toEqual({
      consumerFiles: ["ui/a.ts", "ui/b.ts"],
      supplierFiles: ["core/x.ts", "core/y.ts"],
    });
    expect(endpoints("core", "ui")).toEqual({
      consumerFiles: ["core/x.ts"],
      supplierFiles: ["ui/a.ts"],
    });
    expect(endpoints("ui", "ui")).toEqual({
      consumerFiles: [],
      supplierFiles: [],
    });
  });

  it("keeps declared dependencies between current packages only", () => {
    expect(codex.declaredDependencies).toEqual([
      { from: "@foundry/ui", kind: "dependencies", to: "@foundry/core" },
      { from: "@foundry/ui", kind: "peerDependencies", to: "@foundry/core" },
    ]);
  });

  it("retires absent packages at their last complete checkpoint", () => {
    expect(codex.retiredPackages).toEqual([
      { id: "@foundry/early", label: "early", lastSeen: "2026-01-01" },
      { id: "@foundry/former", label: "former", lastSeen: "2026-03-01" },
    ]);
  });

  it("leaves retirement unknown without history", () => {
    expect(
      resolveCodex({ ...source, history: undefined }).retiredPackages
    ).toBeUndefined();
  });
});

/**
 * 2.2f's characterization, moved unchanged from the retired
 * `current-field.test.ts`: the dependency graph's pair counts, which the
 * codex's routes carry, equal the viewer's old per-pair count of file edges.
 */
describe("pair traffic", () => {
  it("the captured routes' weights equal each pair's cross-package file edges", async () => {
    const data = await loadAtlas();
    const owner = new Map(
      data.territories.flatMap((p) => p.files.map((f) => [f.id, p.id]))
    );
    const counted = new Map<string, number>();
    for (const edge of data.fileEdges) {
      const from = owner.get(edge.source);
      const to = owner.get(edge.target);
      if (from && to && from !== to) {
        const key = `${from}→${to}`;
        counted.set(key, (counted.get(key) ?? 0) + 1);
      }
    }
    expect(counted.size).toBeGreaterThan(0);
    expect(
      new Map(data.routes.map((r) => [`${r.from}→${r.to}`, r.weight]))
    ).toEqual(counted);
  });
});
