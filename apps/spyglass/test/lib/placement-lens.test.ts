import { describe, expect, it } from "vitest";
import type { LensReader } from "../../src/lib/lenses/lens-types";
import type {
  PlacementSource,
  PlacementSourcePackage,
} from "../../src/lib/lenses/placement";
import { placementLens } from "../../src/lib/lenses/placement";
import type { PlacementCounts } from "../../src/lib/lenses/placement-types";
import type { FileKind } from "../../src/lib/types";

const NONE: PlacementCounts = { departs: 0, fits: 0, spread: 0, unconsumed: 0 };

/** Consumer modules that reference a symbol once each. */
function usedBy(...modules: string[]) {
  return modules.map((module) => ({ module, references: 1 }));
}

interface PackageOptions {
  consumed?: Record<string, string[]>;
  directories?: string[];
  files: string[];
  primaryConsumer?: PlacementSourcePackage["dependencies"]["primaryConsumer"];
  shapeSignals?: PlacementSourcePackage["dependencies"]["shapeSignals"];
  symbols: PlacementSourcePackage["symbols"];
}

/** A package at `root`; files and directories are package-relative, symbols root-relative. */
function pkg(
  id: string,
  root: string,
  options: PackageOptions
): PlacementSourcePackage {
  return {
    dependencies: {
      ...(options.primaryConsumer !== undefined && {
        primaryConsumer: options.primaryConsumer,
      }),
      shapeSignals: options.shapeSignals ?? [],
    },
    id,
    root,
    symbols: options.symbols,
    topology: {
      consumedSurface: Object.entries(options.consumed ?? {}).map(
        ([symbolId, consumers]) => ({
          consumers: consumers.map((module) => ({ module })),
          symbolId,
        })
      ),
      directories: (options.directories ?? [".", "src"]).map((directory) => ({
        id: directory,
      })),
      modules: options.files.map((file) => ({
        fileKind: "source" as const,
        id: file,
      })),
      policy: { technicalRoots: ["src"] },
    },
  };
}

function indexed(
  pkgId: string,
  ids: string[],
  fileKind: FileKind = "source"
): PlacementSource["modules"] {
  return ids.map((id) => ({ fileKind, id, package: pkgId }));
}

/** The fixture's `@s/b`: three symbols in one file behind a barrel. */
const SHAPES = pkg("@s/b", "packages/b", {
  files: ["src/index.ts", "src/shape.ts"],
  symbols: [
    {
      consumerModuleUsage: usedBy(
        "apps/a/src/index.ts",
        "tooling/c/src/index.ts"
      ),
      declarationFile: "packages/b/src/shape.ts",
      exported: true,
      id: "packages/b/src/shape.ts#Shape",
    },
    {
      consumerModuleUsage: [
        ...usedBy("apps/a/src/index.ts"),
        // A barrel in another package only forwards it.
        { module: "tooling/c/src/index.ts", references: 0 },
      ],
      declarationFile: "packages/b/src/shape.ts",
      exported: true,
      id: "packages/b/src/shape.ts#area",
    },
    {
      consumerModuleUsage: usedBy(
        "apps/a/src/index.test.ts",
        "tooling/c/src/index.ts"
      ),
      declarationFile: "packages/b/src/shape.ts",
      exported: true,
      id: "packages/b/src/shape.ts#perimeter",
    },
  ],
});

const FIXTURE_MODULES = [
  ...indexed("@s/a", ["apps/a/src/index.ts"]),
  ...indexed("@s/a", ["apps/a/src/index.test.ts"], "test"),
  ...indexed("@s/b", ["packages/b/src/index.ts", "packages/b/src/shape.ts"]),
  ...indexed("@s/c", ["tooling/c/src/index.ts"]),
];

function derive(packages: PlacementSourcePackage[], modules = FIXTURE_MODULES) {
  return placementLens.derive({ missing: [], modules, packages }, {});
}

describe("the placement lens", () => {
  it("labels the fixture's shapes: a test consumer and a forwarding barrel earn no use", () => {
    expect(derive([SHAPES])).toEqual({
      missing: [],
      packages: [
        {
          counts: {
            file: { ...NONE, spread: 1, unconsumed: 1 },
            // `src` is a technical root, so the package has no folder places.
            folder: NONE,
            package: { ...NONE, spread: 1 },
            symbol: { ...NONE, departs: 2, spread: 1 },
          },
          id: "@s/b",
          path: "packages/b",
          shapeSignals: [],
          unindexed: 0,
        },
      ],
      places: [
        {
          away: [
            { modules: ["apps/a/src/index.ts"], package: "@s/a" },
            { modules: ["tooling/c/src/index.ts"], package: "@s/c" },
          ],
          home: { modules: [] },
          label: "spread",
          level: "package",
          package: "@s/b",
          place: "packages/b",
          unindexed: 0,
        },
        {
          away: [
            { modules: ["apps/a/src/index.ts"], package: "@s/a" },
            { modules: ["tooling/c/src/index.ts"], package: "@s/c" },
          ],
          home: { modules: [] },
          label: "spread",
          level: "file",
          package: "@s/b",
          place: "packages/b/src/shape.ts",
          unindexed: 0,
        },
        {
          away: [
            { modules: ["apps/a/src/index.ts"], package: "@s/a" },
            { modules: ["tooling/c/src/index.ts"], package: "@s/c" },
          ],
          home: { modules: [] },
          label: "spread",
          level: "symbol",
          package: "@s/b",
          place: "packages/b/src/shape.ts#Shape",
          unindexed: 0,
        },
        {
          away: [{ modules: ["apps/a/src/index.ts"], package: "@s/a" }],
          home: { modules: [] },
          label: "departs",
          level: "symbol",
          package: "@s/b",
          place: "packages/b/src/shape.ts#area",
          toward: "@s/a",
          unindexed: 0,
        },
        {
          // With the test file counted, this would be a 1:1 split.
          away: [{ modules: ["tooling/c/src/index.ts"], package: "@s/c" }],
          home: { modules: [] },
          label: "departs",
          level: "symbol",
          package: "@s/b",
          place: "packages/b/src/shape.ts#perimeter",
          toward: "@s/c",
          unindexed: 0,
        },
      ],
      policy: { dominantShare: 0.6 },
    });
  });

  it("departs at exactly the dominant share, fits when home holds it, and calls a 1:1 split spread", () => {
    const away = (n: number) =>
      Array.from({ length: n }, (_, i) => `apps/a/src/m${i}.ts`);
    const home = (n: number) =>
      Array.from({ length: n }, (_, i) => `src/h${i}.ts`);
    const symbol = (name: string) => ({
      consumerModuleUsage: [],
      declarationFile: `packages/q/src/${name}.ts`,
      exported: true,
      id: `packages/q/src/${name}.ts#${name}`,
    });
    const ofSymbol = (name: string, awayCount: number) => ({
      ...symbol(name),
      consumerModuleUsage: usedBy(...away(awayCount)),
    });
    const q = pkg("@s/q", "packages/q", {
      consumed: {
        "packages/q/src/even.ts#even": home(1),
        "packages/q/src/fits.ts#fits": home(3),
        "packages/q/src/three.ts#three": home(2),
      },
      files: ["src/three.ts", "src/even.ts", "src/fits.ts", ...home(3)],
      symbols: [ofSymbol("three", 3), ofSymbol("even", 1), ofSymbol("fits", 2)],
    });
    const modules = [
      ...indexed("@s/a", away(3)),
      ...indexed(
        "@s/q",
        ["src/three.ts", "src/even.ts", "src/fits.ts", ...home(3)].map(
          (file) => `packages/q/${file}`
        )
      ),
    ];
    const labels = Object.fromEntries(
      derive([q], modules)
        .places.filter((placement) => placement.level === "symbol")
        .map((placement) => [placement.place, placement.label])
    );
    expect(labels).toEqual({
      "packages/q/src/even.ts#even": "spread",
      "packages/q/src/fits.ts#fits": "fits",
      "packages/q/src/three.ts#three": "departs",
    });
  });

  it("names the one package consuming a package as where it departs toward, beside its own report's signals", () => {
    const lib = pkg("@s/lib", "packages/lib", {
      // Heavy use at home never counts for the package itself.
      consumed: { "packages/lib/src/a.ts#a": ["src/b.ts"] },
      files: ["src/a.ts", "src/b.ts"],
      primaryConsumer: {
        package: "@s/app",
        referenceShare: 1,
        surfaceShare: 1,
      },
      shapeSignals: ["single-consumer", "concentrated-consumption"],
      symbols: [
        {
          consumerModuleUsage: usedBy("apps/app/src/x.ts"),
          declarationFile: "packages/lib/src/a.ts",
          exported: true,
          id: "packages/lib/src/a.ts#a",
        },
        {
          consumerModuleUsage: usedBy("apps/app/src/y.ts"),
          declarationFile: "packages/lib/src/b.ts",
          exported: true,
          id: "packages/lib/src/b.ts#b",
        },
      ],
    });
    const modules = [
      ...indexed("@s/app", ["apps/app/src/x.ts", "apps/app/src/y.ts"]),
      ...indexed("@s/lib", ["packages/lib/src/a.ts", "packages/lib/src/b.ts"]),
    ];
    const lens = derive([lib], modules);
    expect(
      lens.places.find((placement) => placement.level === "package")
    ).toEqual({
      away: [
        {
          modules: ["apps/app/src/x.ts", "apps/app/src/y.ts"],
          package: "@s/app",
        },
      ],
      home: { modules: [] },
      label: "departs",
      level: "package",
      package: "@s/lib",
      place: "packages/lib",
      toward: "@s/app",
      unindexed: 0,
    });
    expect(lens.packages[0]).toMatchObject({
      primaryConsumer: { package: "@s/app" },
      shapeSignals: ["single-consumer", "concentrated-consumption"],
    });
  });

  it("counts a consumer outside the module index as unindexed, never in a label, and the package's distinct ones", () => {
    const lens = derive([
      pkg("@s/b", "packages/b", {
        files: ["src/shape.ts", "src/size.ts"],
        symbols: [
          {
            consumerModuleUsage: usedBy(
              "apps/a/src/index.ts",
              "scripts/build.ts"
            ),
            declarationFile: "packages/b/src/shape.ts",
            exported: true,
            id: "packages/b/src/shape.ts#area",
          },
          {
            // A failed package's file and a root script: unindexed only.
            consumerModuleUsage: usedBy(
              "packages/failed/src/x.ts",
              "scripts/build.ts"
            ),
            declarationFile: "packages/b/src/size.ts",
            exported: true,
            id: "packages/b/src/size.ts#size",
          },
        ],
      }),
    ]);
    const area = lens.places.find(
      (placement) => placement.place === "packages/b/src/shape.ts#area"
    );
    expect(area).toMatchObject({
      away: [{ modules: ["apps/a/src/index.ts"], package: "@s/a" }],
      label: "departs",
      unindexed: 1,
    });
    expect(
      lens.places.some((placement) =>
        placement.place.startsWith("packages/b/src/size.ts")
      )
    ).toBe(false);
    expect(lens.packages[0]?.counts.symbol).toEqual({
      ...NONE,
      departs: 1,
      unconsumed: 1,
    });
    expect(lens.packages[0]?.unindexed).toBe(2);
  });

  it("makes no place of a symbol its module does not export, neither a row nor a count", () => {
    const lens = derive([
      pkg("@s/b", "packages/b", {
        consumed: { "packages/b/src/shape.ts#inner": ["src/index.ts"] },
        files: ["src/index.ts", "src/shape.ts"],
        symbols: [
          {
            consumerModuleUsage: usedBy("apps/a/src/index.ts"),
            declarationFile: "packages/b/src/shape.ts",
            exported: false,
            id: "packages/b/src/shape.ts#inner",
          },
          {
            consumerModuleUsage: [],
            declarationFile: "packages/b/src/shape.ts",
            exported: false,
            id: "packages/b/src/shape.ts#helper",
          },
        ],
      }),
    ]);
    expect(lens.places).toEqual([]);
    expect(lens.packages[0]?.counts.symbol).toEqual(NONE);
    expect(lens.packages[0]?.counts.file).toEqual({ ...NONE, unconsumed: 2 });
  });

  it("gives a folder the use of the symbols inside it, less the modules inside it", () => {
    const q = pkg("@s/q", "packages/q", {
      consumed: {
        "packages/q/src/deep/a.ts#a": ["src/deep/b.ts", "src/top.ts"],
      },
      directories: [".", "src", "src/deep"],
      files: ["src/deep/a.ts", "src/deep/b.ts", "src/top.ts"],
      symbols: [
        {
          consumerModuleUsage: usedBy("apps/a/src/index.ts"),
          declarationFile: "packages/q/src/deep/a.ts",
          exported: true,
          id: "packages/q/src/deep/a.ts#a",
        },
      ],
    });
    const modules = [
      ...indexed("@s/a", ["apps/a/src/index.ts"]),
      ...indexed(
        "@s/q",
        ["src/deep/a.ts", "src/deep/b.ts", "src/top.ts"].map(
          (file) => `packages/q/${file}`
        )
      ),
    ];
    const byPlace = Object.fromEntries(
      derive([q], modules).places.map((placement) => [
        placement.place,
        [placement.label, placement.home.modules],
      ])
    );
    expect(byPlace).toEqual({
      "packages/q": ["departs", []],
      "packages/q/src/deep": ["spread", ["packages/q/src/top.ts"]],
      "packages/q/src/deep/a.ts": [
        "fits",
        ["packages/q/src/deep/b.ts", "packages/q/src/top.ts"],
      ],
      "packages/q/src/deep/a.ts#a": [
        "fits",
        ["packages/q/src/deep/b.ts", "packages/q/src/top.ts"],
      ],
    });
  });

  it("makes one place of two declarations that share an id", () => {
    const lens = derive([
      pkg("@s/b", "packages/b", {
        files: ["src/shape.ts"],
        symbols: [
          {
            consumerModuleUsage: usedBy("apps/a/src/index.ts"),
            declarationFile: "packages/b/src/shape.ts",
            exported: true,
            id: "packages/b/src/shape.ts#Shape",
          },
          {
            consumerModuleUsage: usedBy("tooling/c/src/index.ts"),
            declarationFile: "packages/b/src/shape.ts",
            exported: true,
            id: "packages/b/src/shape.ts#Shape",
          },
        ],
      }),
    ]);
    const symbols = lens.places.filter(
      (placement) => placement.level === "symbol"
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.label).toBe("spread");
    expect(lens.packages[0]?.counts.symbol).toEqual({ ...NONE, spread: 1 });
  });

  it("sorts places by place, then level, then package, whatever the order of its inputs", () => {
    // A package nested in another's folder: the folder and the package root
    // are one place at two levels.
    const outer = pkg("@s/o", "packages/o", {
      consumed: {
        "packages/o/src/a.ts#a": ["src/b.ts", "src/c.ts"],
        "packages/o/src/b.ts#b": ["src/c.ts"],
      },
      directories: [".", "src", "nested"],
      files: ["src/a.ts", "src/b.ts", "src/c.ts", "nested/a.ts"],
      symbols: [
        {
          consumerModuleUsage: usedBy("apps/a/src/index.ts"),
          declarationFile: "packages/o/nested/a.ts",
          exported: true,
          id: "packages/o/nested/a.ts#a",
        },
        {
          consumerModuleUsage: usedBy("apps/a/src/index.ts"),
          declarationFile: "packages/o/src/a.ts",
          exported: true,
          id: "packages/o/src/a.ts#a",
        },
        {
          consumerModuleUsage: usedBy("apps/a/src/other.ts"),
          declarationFile: "packages/o/src/b.ts",
          exported: true,
          id: "packages/o/src/b.ts#b",
        },
      ],
    });
    const nested = pkg("@s/n", "packages/o/nested", {
      files: ["b.ts"],
      symbols: [
        {
          consumerModuleUsage: usedBy("apps/a/src/index.ts"),
          declarationFile: "packages/o/nested/b.ts",
          exported: true,
          id: "packages/o/nested/b.ts#b",
        },
      ],
    });
    const modules = [
      ...FIXTURE_MODULES,
      ...indexed("@s/a", ["apps/a/src/other.ts"]),
      ...indexed(
        "@s/o",
        ["src/a.ts", "src/b.ts", "src/c.ts", "nested/a.ts"].map(
          (file) => `packages/o/${file}`
        )
      ),
      ...indexed("@s/n", ["packages/o/nested/b.ts"]),
    ];
    const reversed = (source: PlacementSourcePackage) => ({
      ...source,
      symbols: [...source.symbols].reverse(),
      topology: {
        ...source.topology,
        consumedSurface: [...source.topology.consumedSurface]
          .reverse()
          .map((consumed) => ({
            ...consumed,
            consumers: [...consumed.consumers].reverse(),
          })),
        directories: [...source.topology.directories].reverse(),
        modules: [...source.topology.modules].reverse(),
      },
    });
    const lens = derive([outer, nested, SHAPES], modules);
    const shuffled = derive(
      [reversed(SHAPES), reversed(nested), reversed(outer)],
      [...modules].reverse()
    );
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(lens));
    expect(
      lens.places
        .filter((placement) => placement.place === "packages/o/nested")
        .map((placement) => [placement.level, placement.package])
    ).toEqual([
      ["folder", "@s/o"],
      ["package", "@s/n"],
    ]);
  });

  it("reads package reports one at a time for packages with internals, keeping only the fields it needs", async () => {
    let reading = 0;
    let mostAtOnce = 0;
    const reports: string[] = [];
    const internals = {
      topology: {
        consumedSurface: [
          {
            consumerModules: 1,
            consumers: [
              // A type-only import is a home consumer like any other.
              {
                bindingOccurrences: 1,
                importSites: 1,
                module: "src/index.ts",
                namespaceSites: 0,
                typeOnlySites: 1,
              },
            ],
            name: "Unit",
            symbolId: "tooling/c/src/unit.ts#Unit",
          },
        ],
        directories: [
          { depth: 0, id: "." },
          { depth: 1, id: "src" },
        ],
        modules: [
          { fanIn: 0, fileKind: "source", id: "src/index.ts" },
          { fanIn: 1, fileKind: "source", id: "src/unit.ts" },
        ],
        package: { id: "@s/c", root: "tooling/c" },
        policy: { highFan: {}, technicalRoots: ["src"] },
      },
    };
    const reader = {
      internals: () => Promise.resolve(internals),
      moduleIndex: () =>
        Promise.resolve({
          modules: [
            {
              fileKind: "source",
              id: "tooling/c/src/index.ts",
              package: "@s/c",
              shard: "modules/@s__c.json",
            },
            {
              fileKind: "source",
              id: "tooling/c/src/unit.ts",
              package: "@s/c",
              shard: "modules/@s__c.json",
            },
          ],
        }),
      packageReport: async (id: string) => {
        reports.push(id);
        reading += 1;
        mostAtOnce = Math.max(mostAtOnce, reading);
        await new Promise((resolve) => setTimeout(resolve, 1));
        reading -= 1;
        return {
          churn: "a large field the lens never reads",
          dependencies: { incoming: ["unread"], shapeSignals: [] },
          symbols: [
            {
              consumerModuleUsage: [],
              consumers: ["unread"],
              declarationFile: "tooling/c/src/unit.ts",
              exported: true,
              id: "tooling/c/src/unit.ts#Unit",
              kind: "type",
            },
          ],
        };
      },
      packages: () => [
        { id: "@s/c", internals: true, status: "complete" },
        { id: "@s/d", internals: true, status: "complete" },
        { id: "@s/e", internals: false, status: "complete" },
        { id: "@s/f", internals: false, status: "failed" },
      ],
    } as unknown as LensReader;
    const source = await placementLens.read(reader, {});
    expect(mostAtOnce).toBe(1);
    expect(reports).toEqual(["@s/c", "@s/d"]);
    expect(source.missing).toEqual(["@s/e"]);
    expect(source.packages[0]).toEqual({
      dependencies: { shapeSignals: [] },
      id: "@s/c",
      root: "tooling/c",
      symbols: [
        {
          consumerModuleUsage: [],
          declarationFile: "tooling/c/src/unit.ts",
          exported: true,
          id: "tooling/c/src/unit.ts#Unit",
        },
      ],
      topology: {
        consumedSurface: [
          {
            consumers: [{ module: "src/index.ts" }],
            symbolId: "tooling/c/src/unit.ts#Unit",
          },
        ],
        directories: [{ id: "." }, { id: "src" }],
        modules: [
          { fileKind: "source", id: "src/index.ts" },
          { fileKind: "source", id: "src/unit.ts" },
        ],
        policy: { technicalRoots: ["src"] },
      },
    });
    const lens = placementLens.derive(source, {});
    // Used at home only, so it fits and is counted, not listed.
    expect(lens.places).toEqual([]);
    expect(lens.packages[0]?.counts.symbol).toEqual({ ...NONE, fits: 1 });
    expect(lens.missing).toEqual(["@s/e"]);
  });
});
