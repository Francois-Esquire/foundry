import { describe, expect, it } from "vitest";
import type { LensReader } from "../../src/lib/lenses/lens-types";
import type {
  NestingSource,
  NestingSourceInternals,
} from "../../src/lib/lenses/nesting";
import { nestingLens } from "../../src/lib/lenses/nesting";
import { rootRelativeFolder } from "../../src/lib/lenses/package-internals";
import type { PlacementSourcePackage } from "../../src/lib/lenses/placement";
import { placementLens } from "../../src/lib/lenses/placement";

function files(...ids: string[]): NestingSource["modules"] {
  return ids.map((id) => ({ id }));
}

/** A package's topology: directory ids with their path regions, the regions, and the seams. */
function internalsOf(
  id: string,
  root: string,
  directories: Record<string, string>,
  topology: Partial<
    Pick<NestingSourceInternals["topology"], "regions" | "seams">
  > = {}
): NestingSourceInternals {
  return {
    id,
    root,
    topology: {
      directories: Object.entries(directories).map(([directory, region]) => ({
        id: directory,
        region,
      })),
      regions: topology.regions ?? [],
      seams: topology.seams ?? [],
    },
  };
}

function derive(source: Partial<NestingSource>) {
  return nestingLens.derive(
    { internals: [], missing: [], modules: [], packages: [], ...source },
    {}
  );
}

describe("the nesting lens", () => {
  it("builds one tree from the module index, with path regions and seams from internals and the rest missing", () => {
    const lens = derive({
      internals: [
        internalsOf(
          "@w/a",
          "packages/a",
          { ".": ".", src: ".", "src/util": "util" },
          {
            regions: [
              { id: ".", modules: 2, primaryModules: 1 },
              { id: "util", modules: 1, primaryModules: 1 },
            ],
            seams: [
              {
                from: "util",
                importSites: 3,
                moduleEdges: 2,
                symbolFlow: 1,
                to: ".",
              },
            ],
          }
        ),
      ],
      missing: ["@w/b"],
      modules: files(
        "packages/a/src/index.ts",
        "packages/a/src/index.test.ts",
        "packages/a/src/util/pad.ts",
        "packages/b/src/x.ts"
      ),
      packages: [
        { id: "@w/a", path: "packages/a" },
        { id: "@w/b", path: "packages/b" },
      ],
    });
    expect(lens).toEqual({
      folders: [
        {
          fileCounts: { descendant: 4, direct: 0 },
          id: "packages",
          packageRoot: false,
        },
        {
          fileCounts: { descendant: 3, direct: 0 },
          id: "packages/a",
          package: "@w/a",
          packageRoot: true,
          parent: "packages",
          pathRegion: ".",
        },
        {
          fileCounts: { descendant: 3, direct: 2 },
          id: "packages/a/src",
          package: "@w/a",
          packageRoot: false,
          parent: "packages/a",
          pathRegion: ".",
        },
        {
          fileCounts: { descendant: 1, direct: 1 },
          id: "packages/a/src/util",
          package: "@w/a",
          packageRoot: false,
          parent: "packages/a/src",
          pathRegion: "util",
        },
        {
          fileCounts: { descendant: 1, direct: 0 },
          id: "packages/b",
          package: "@w/b",
          packageRoot: true,
          parent: "packages",
        },
        {
          fileCounts: { descendant: 1, direct: 1 },
          id: "packages/b/src",
          package: "@w/b",
          packageRoot: false,
          parent: "packages/b",
        },
      ],
      missing: ["@w/b"],
      pathRegions: [
        { files: 2, id: ".", package: "@w/a", primaryFiles: 1 },
        { files: 1, id: "util", package: "@w/a", primaryFiles: 1 },
      ],
      seams: [
        {
          from: "util",
          importSites: 3,
          moduleEdges: 2,
          package: "@w/a",
          symbolFlow: 1,
          to: ".",
        },
      ],
    });
  });

  it("makes the workspace root the folder of a package that lives there, owning every folder no other package root holds", () => {
    for (const path of ["", "."]) {
      const lens = derive({
        internals: [internalsOf("@w/root", path, { ".": ".", lib: "lib" })],
        modules: files("index.ts", "lib/x.ts", "packages/a/a.ts"),
        packages: [
          { id: "@w/root", path },
          { id: "@w/a", path: "packages/a" },
        ],
      });
      expect(
        lens.folders.map(
          ({ fileCounts: counts, id, package: pkg, parent, pathRegion }) => [
            id,
            parent,
            pkg,
            counts.direct,
            counts.descendant,
            pathRegion,
          ]
        )
      ).toEqual([
        [".", undefined, "@w/root", 1, 3, "."],
        ["lib", ".", "@w/root", 1, 1, "lib"],
        ["packages", ".", "@w/root", 0, 1, undefined],
        ["packages/a", "packages", "@w/a", 1, 1, undefined],
      ]);
    }
  });

  it("puts a nested package's root under the folder of the package around it, and keeps a package root with no file", () => {
    const lens = derive({
      modules: files("packages/o/src/a.ts", "packages/o/nested/b.ts"),
      packages: [
        { id: "@s/o", path: "packages/o" },
        { id: "@s/n", path: "packages/o/nested" },
        { id: "@s/e", path: "tools/empty" },
      ],
    });
    expect(
      lens.folders.map(({ id, package: pkg, packageRoot, parent }) => [
        id,
        parent,
        pkg,
        packageRoot,
      ])
    ).toEqual([
      ["packages", undefined, undefined, false],
      ["packages/o", "packages", "@s/o", true],
      ["packages/o/nested", "packages/o", "@s/n", true],
      ["packages/o/src", "packages/o", "@s/o", false],
      ["tools", undefined, undefined, false],
      ["tools/empty", "tools", "@s/e", true],
    ]);
  });

  it("takes a folder's path region only from the package that owns it, whatever the order of the internals", () => {
    const modules = files("packages/o/src/a.ts", "packages/o/nested/b.ts");
    const packages = [
      { id: "@s/o", path: "packages/o" },
      { id: "@s/n", path: "packages/o/nested" },
    ];
    // The outer topology also lists the nested package's root.
    const outer = internalsOf("@s/o", "packages/o", {
      ".": ".",
      nested: "nested",
      src: ".",
    });
    const inner = internalsOf("@s/n", "packages/o/nested", { ".": "inner" });
    const regionOf = (lens: ReturnType<typeof derive>) =>
      lens.folders.find((folder) => folder.id === "packages/o/nested")
        ?.pathRegion;
    expect(
      regionOf(derive({ internals: [outer, inner], modules, packages }))
    ).toBe("inner");
    expect(
      regionOf(derive({ internals: [inner, outer], modules, packages }))
    ).toBe("inner");
    // Without the nested package's own internals, the folder has no region.
    expect(
      regionOf(
        derive({ internals: [outer], missing: ["@s/n"], modules, packages })
      )
    ).toBeUndefined();
  });

  it("names a folder as placement does, so a folder in one lens is the same folder in the other", () => {
    const directories = { ".": ".", src: ".", "src/deep": "deep" };
    const index = [
      "packages/q/src/deep/a.ts",
      "packages/q/src/top.ts",
      "apps/a/src/index.ts",
      // A folder of data files only: in the index, not in the topology.
      "packages/q/src/data/table.json",
    ];
    const placementSource: PlacementSourcePackage = {
      dependencies: { shapeSignals: [] },
      id: "@s/q",
      root: "packages/q",
      symbols: [
        {
          consumerModuleUsage: [
            { module: "apps/a/src/index.ts", references: 1 },
          ],
          declarationFile: "packages/q/src/deep/a.ts",
          exported: true,
          id: "packages/q/src/deep/a.ts#a",
        },
      ],
      topology: {
        consumedSurface: [],
        directories: Object.keys(directories).map((id) => ({ id })),
        modules: ["src/deep/a.ts", "src/top.ts"].map((id) => ({
          fileKind: "source" as const,
          id,
        })),
        policy: { technicalRoots: ["src"] },
      },
    };
    const placement = placementLens.derive(
      {
        missing: [],
        modules: [
          {
            fileKind: "source",
            id: "packages/q/src/deep/a.ts",
            package: "@s/q",
          },
          { fileKind: "source", id: "packages/q/src/top.ts", package: "@s/q" },
          { fileKind: "source", id: "apps/a/src/index.ts", package: "@s/a" },
          {
            fileKind: "other",
            id: "packages/q/src/data/table.json",
            package: "@s/q",
          },
        ],
        packages: [placementSource],
      },
      {}
    );
    const nesting = derive({
      internals: [internalsOf("@s/q", "packages/q", directories)],
      modules: files(...index),
      packages: [
        { id: "@s/q", path: "packages/q" },
        { id: "@s/a", path: "apps/a" },
      ],
    });
    const nested = nesting.folders
      .filter((folder) => folder.package === "@s/q")
      .map((folder) => folder.id);
    for (const [directory, region] of Object.entries(directories)) {
      const id = rootRelativeFolder("packages/q", directory);
      expect(
        nesting.folders.find((folder) => folder.id === id)?.pathRegion
      ).toBe(region);
    }
    expect(nested).toEqual([
      "packages/q",
      "packages/q/src",
      "packages/q/src/data",
      "packages/q/src/deep",
    ]);
    expect(
      nesting.folders.find((folder) => folder.id === "packages/q/src/data")
    ).not.toHaveProperty("pathRegion");
    const placedFolders = placement.places
      .filter((place) => place.level === "folder" || place.level === "package")
      .map((place) => place.place);
    expect(placedFolders).toEqual(["packages/q", "packages/q/src/deep"]);
    for (const folder of placedFolders) {
      expect(nested).toContain(folder);
    }
  });

  it("gives the same output for its inputs in any order", () => {
    const source: NestingSource = {
      internals: [
        internalsOf(
          "@w/a",
          "packages/a",
          { ".": ".", src: ".", "src/util": "util" },
          {
            regions: [
              { id: "util", modules: 1, primaryModules: 1 },
              { id: ".", modules: 1, primaryModules: 1 },
            ],
            seams: [
              {
                from: "util",
                importSites: 1,
                moduleEdges: 1,
                symbolFlow: 1,
                to: ".",
              },
              {
                from: ".",
                importSites: 1,
                moduleEdges: 1,
                symbolFlow: 1,
                to: "util",
              },
            ],
          }
        ),
        internalsOf("@w/b", "packages/b", { ".": "." }),
      ],
      missing: [],
      modules: files(
        "packages/a/src/x.ts",
        "packages/a/src/util/y.ts",
        "packages/b/z.ts"
      ),
      packages: [
        { id: "@w/a", path: "packages/a" },
        { id: "@w/b", path: "packages/b" },
      ],
    };
    const reversed: NestingSource = {
      internals: [...source.internals].reverse().map((pkg) => ({
        ...pkg,
        topology: {
          directories: [...pkg.topology.directories].reverse(),
          regions: [...pkg.topology.regions].reverse(),
          seams: [...pkg.topology.seams].reverse(),
        },
      })),
      missing: [],
      modules: [...source.modules].reverse(),
      packages: [...source.packages].reverse(),
    };
    expect(JSON.stringify(nestingLens.derive(reversed, {}))).toBe(
      JSON.stringify(nestingLens.derive(source, {}))
    );
  });

  it("reads the module index, the complete packages' paths, and only the topology fields it needs", async () => {
    const reader = {
      internals: () =>
        Promise.resolve({
          topology: {
            directories: [
              { depth: 0, id: ".", parent: undefined, region: "." },
            ],
            modules: ["unread"],
            package: { id: "@s/a", root: "packages/a" },
            regions: [
              { directories: 1, id: ".", modules: 1, primaryModules: 1 },
            ],
            seams: [],
          },
        }),
      moduleIndex: () =>
        Promise.resolve({
          modules: [
            {
              fileKind: "source",
              id: "packages/a/x.ts",
              package: "@s/a",
              shard: "modules/@s__a.json",
            },
          ],
        }),
      packages: () => [
        { id: "@s/a", internals: true, path: "packages/a", status: "complete" },
        {
          id: "@s/b",
          internals: false,
          path: "packages/b",
          status: "complete",
        },
        { id: "@s/c", internals: false, path: "packages/c", status: "failed" },
      ],
    } as unknown as LensReader;
    expect(await nestingLens.read(reader, {})).toEqual({
      internals: [
        {
          id: "@s/a",
          root: "packages/a",
          topology: {
            directories: [{ id: ".", region: "." }],
            regions: [{ id: ".", modules: 1, primaryModules: 1 }],
            seams: [],
          },
        },
      ],
      missing: ["@s/b"],
      modules: [{ id: "packages/a/x.ts" }],
      packages: [
        { id: "@s/a", path: "packages/a" },
        { id: "@s/b", path: "packages/b" },
      ],
    });
  });
});
