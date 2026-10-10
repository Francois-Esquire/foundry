import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeInternalPackageTopology } from "../../src/lib/internal-topology";
import type { LensReader } from "../../src/lib/lenses/lens-types";
import { nestingLens } from "../../src/lib/lenses/nesting";
import { rootRelativeFolder } from "../../src/lib/lenses/package-internals";
import { directoryDistance, folderOf } from "../../src/lib/lenses/paths";
import type {
  ProximitySource,
  ProximitySourcePackage,
} from "../../src/lib/lenses/proximity";
import { proximityLens } from "../../src/lib/lenses/proximity";
import { analyzePackageLocal } from "../../src/lib/package-local";

type Module = ProximitySourcePackage["responsibilities"]["modules"][number];

/** A module in `region`, or unresolved without one; ids are package-relative. */
function placed(module: string, region?: string, agrees?: boolean): Module {
  return {
    directory: folderOf(module),
    module,
    ...(agrees !== undefined && { pathAgreesWithRegion: agrees }),
    ...(region !== undefined && { region }),
  };
}

function pkg(
  id: string,
  root: string,
  modules: Module[],
  options: {
    dominant?: Record<string, string>;
    relationships?: [string, string][];
  } = {}
): ProximitySourcePackage {
  const regions = [
    ...new Set(modules.flatMap((module) => module.region ?? [])),
  ];
  return {
    id,
    responsibilities: {
      modules,
      regions: regions.map((region) => ({
        id: region,
        modules: modules
          .filter((module) => module.region === region)
          .map((module) => module.module),
        path: {
          dominantDirectory: { id: options.dominant?.[region] ?? "src/x" },
        },
      })),
      relationships: (options.relationships ?? []).map(([from, to]) => ({
        from,
        to,
      })),
    },
    root,
  };
}

function coChange(
  left: string,
  right: string,
  rest: Partial<ProximitySource["coChanges"][number]> = {}
): ProximitySource["coChanges"][number] {
  return {
    coChangeCommits: 3,
    context: "source-source",
    id: `${left}|${right}`,
    jaccard: 0.5,
    left,
    right,
    scope:
      left.split("/")[1] === right.split("/")[1]
        ? "same-package"
        : "cross-package",
    staticPath: "none",
    ...rest,
  };
}

function derive(source: Partial<ProximitySource>) {
  return proximityLens.derive(
    { coChanges: [], missing: [], packages: [], ...source },
    {}
  );
}

const A = pkg(
  "@w/a",
  "packages/a",
  [
    placed("src/x/a.ts", "R1", true),
    placed("src/x/b.ts", "R2", true),
    placed("src/x/c.ts", "R3", true),
    placed("src/x/d.ts", "R4", true),
    placed("src/x/u.ts"),
    // R1's dominant folder is src/x, so this file sits apart from it.
    placed("src/y/e.ts", "R1", false),
    placed("src/z/f.ts", "R5", true),
    placed("src/z/g.ts", "R6", true),
    placed("src/z/h.ts", "R7", true),
  ],
  {
    dominant: { R5: "src/z", R6: "src/z", R7: "src/z" },
    relationships: [
      ["R3", "R1"],
      ["R5", "R6"],
      ["R6", "R7"],
    ],
  }
);

describe("directoryDistance", () => {
  it("counts the folder steps up to the deepest common folder and down again", () => {
    expect(directoryDistance("a/b", "a/b")).toBe(0);
    expect(directoryDistance("a", "a/b")).toBe(1);
    expect(directoryDistance("a/b", "a/c")).toBe(2);
    expect(directoryDistance(".", "a/b")).toBe(2);
    expect(directoryDistance("packages/a/src/x", "packages/b/src")).toBe(5);
  });
});

describe("directoryDistance against the internal topology", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("gives every edge of a package the distance the topology saved", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "proximity-")));
    roots.push(root);
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
      }),
      "packages/p/main.ts":
        'import { index } from "./src/index";\nexport const main = index;\n',
      "packages/p/package.json": JSON.stringify({
        exports: { ".": "./src/index.ts" },
        name: "@f/p",
      }),
      "packages/p/scripts/run.ts":
        'import { index } from "../src/index";\nexport const run = index;\n',
      "packages/p/src/canvas/editor/a.ts":
        'import { b } from "../runtime/b";\nimport { c } from "../../tasks/c";\nexport const a = b + c;\n',
      "packages/p/src/canvas/runtime/b.ts": "export const b = 1;\n",
      "packages/p/src/index.ts":
        'import { a } from "./canvas/editor/a";\nexport const index = a;\n',
      "packages/p/src/tasks/c.ts": "export const c = 2;\n",
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const topology = analyzeInternalPackageTopology(
      analyzePackageLocal({ root, target: "packages/p" })
    );
    const directoryOf = new Map(
      topology.modules.map((module) => [module.id, module.directory])
    );
    const distances = topology.edges.map((edge) => {
      const source = directoryOf.get(edge.source) ?? "";
      const target = directoryOf.get(edge.target) ?? "";
      expect(directoryDistance(source, target)).toBe(edge.distance);
      // Root-relative, as the lens measures, the distance is the same.
      expect(
        directoryDistance(
          rootRelativeFolder(topology.package.root, source),
          rootRelativeFolder(topology.package.root, target)
        )
      ).toBe(edge.distance);
      return edge.distance;
    });
    expect(new Set(distances)).toEqual(new Set([1, 2, 3]));
  });
});

describe("the proximity lens", () => {
  it("reports a folder's unrelated groups of responsibilities, joined by relationships and source co-changes, and counts unresolved files", () => {
    const lens = derive({
      coChanges: [
        coChange("packages/a/src/x/b.ts", "packages/a/src/x/d.ts"),
        // A test companion relates nothing.
        coChange("packages/a/src/x/b.ts", "packages/a/src/x/c.ts", {
          context: "source-test",
        }),
      ],
      packages: [A],
    });
    expect(lens.close).toEqual([
      {
        folder: "packages/a/src/x",
        groups: [
          {
            apart: [],
            files: ["packages/a/src/x/a.ts", "packages/a/src/x/c.ts"],
            responsibilities: ["R1", "R3"],
          },
          {
            apart: [],
            files: ["packages/a/src/x/b.ts", "packages/a/src/x/d.ts"],
            responsibilities: ["R2", "R4"],
          },
        ],
        package: "@w/a",
        unresolved: 1,
      },
    ]);
    // R5, R6, and R7 are related through R6, so src/z is one group.
    expect(lens.packages).toEqual([{ id: "@w/a", unresolved: 1 }]);
  });

  it("joins a folder's responsibilities only through others in the same folder, and names a group's files that are apart", () => {
    const lens = derive({
      packages: [
        pkg(
          "@w/a",
          "packages/a",
          [
            placed("src/x/a.ts", "R1", true),
            placed("src/x/b.ts", "R2", true),
            // Both relate to R3, which has no file in src/x.
            placed("src/w/c.ts", "R3", true),
            // R4's files are in src/w, so this one is apart.
            placed("src/x/k.ts", "R4", false),
            placed("src/w/l.ts", "R4", true),
          ],
          {
            dominant: { R1: "src/x", R2: "src/x", R3: "src/w", R4: "src/w" },
            relationships: [
              ["R1", "R3"],
              ["R3", "R2"],
            ],
          }
        ),
      ],
    });
    expect(
      lens.close.filter((folder) => folder.folder === "packages/a/src/x")
    ).toEqual([
      {
        folder: "packages/a/src/x",
        groups: [
          {
            apart: [],
            files: ["packages/a/src/x/a.ts"],
            responsibilities: ["R1"],
          },
          {
            apart: [],
            files: ["packages/a/src/x/b.ts"],
            responsibilities: ["R2"],
          },
          {
            apart: ["packages/a/src/x/k.ts"],
            files: ["packages/a/src/x/k.ts"],
            responsibilities: ["R4"],
          },
        ],
        package: "@w/a",
        unresolved: 0,
      },
    ]);
    expect(lens.apart.files.map((file) => file.file)).toEqual([
      "packages/a/src/x/k.ts",
    ]);
  });

  it("lists a file whose responsibility's folder is another, with the steps between them", () => {
    expect(derive({ packages: [A] }).apart.files).toEqual([
      {
        distance: 2,
        file: "packages/a/src/y/e.ts",
        folder: "packages/a/src/y",
        package: "@w/a",
        responsibility: "R1",
        responsibilityFolder: "packages/a/src/x",
      },
    ]);
  });

  it("keeps co-changing source files from different folders, as stored, with the steps between them", () => {
    const lens = derive({
      coChanges: [
        coChange("packages/a/src/x/a.ts", "packages/b/src/z.ts", {
          staticPath: "indirect",
        }),
        coChange("packages/a/src/x/a.ts", "packages/a/src/x/b.ts"),
        coChange("packages/a/src/x/a.ts", "packages/a/test/a.test.ts", {
          context: "source-test",
        }),
      ],
    });
    expect(lens.apart.coChanges).toEqual([
      {
        coChangeCommits: 3,
        distance: 5,
        id: "packages/a/src/x/a.ts|packages/b/src/z.ts",
        jaccard: 0.5,
        left: "packages/a/src/x/a.ts",
        right: "packages/b/src/z.ts",
        scope: "cross-package",
        staticPath: "indirect",
      },
    ]);
  });

  it("measures a package at the workspace root from the root folder", () => {
    const root = pkg(
      "@w/root",
      "",
      [placed("lib/a.ts", "R1", false), placed("b.ts", "R1", true)],
      { dominant: { R1: "." } }
    );
    expect(derive({ packages: [root] }).apart.files).toEqual([
      {
        distance: 1,
        file: "lib/a.ts",
        folder: "lib",
        package: "@w/root",
        responsibility: "R1",
        responsibilityFolder: ".",
      },
    ]);
  });

  it("names every folder as the nesting lens does", () => {
    const lens = derive({
      coChanges: [coChange("packages/a/src/x/a.ts", "packages/a/src/z/f.ts")],
      packages: [A],
    });
    const nesting = nestingLens.derive(
      {
        internals: [],
        missing: [],
        modules: A.responsibilities.modules.map((module) => ({
          id: `packages/a/${module.module}`,
        })),
        packages: [{ id: "@w/a", path: "packages/a" }],
      },
      {}
    );
    const folders = new Set(nesting.folders.map((folder) => folder.id));
    const named = [
      ...lens.close.map((folder) => folder.folder),
      ...lens.apart.files.flatMap((file) => [
        file.folder,
        file.responsibilityFolder,
      ]),
      ...lens.apart.coChanges.flatMap((pair) => [
        folderOf(pair.left),
        folderOf(pair.right),
      ]),
    ];
    expect(named.length).toBeGreaterThan(0);
    for (const folder of named) {
      expect(folders).toContain(folder);
    }
  });

  it("gives the same output for its inputs in any order", () => {
    const coChanges = [
      coChange("packages/a/src/x/b.ts", "packages/a/src/x/d.ts"),
      coChange("packages/a/src/x/a.ts", "packages/a/src/z/f.ts"),
      coChange("packages/a/src/y/e.ts", "packages/b/src/z.ts"),
    ];
    const reversed: ProximitySourcePackage = {
      ...A,
      responsibilities: {
        modules: [...A.responsibilities.modules].reverse(),
        regions: [...A.responsibilities.regions].reverse().map((region) => ({
          ...region,
          modules: [...region.modules].reverse(),
        })),
        relationships: [...A.responsibilities.relationships].reverse(),
      },
    };
    const other = pkg("@w/b", "packages/b", [placed("src/z.ts", "S1", true)]);
    expect(
      JSON.stringify(
        derive({
          coChanges: [...coChanges].reverse(),
          packages: [other, reversed],
        })
      )
    ).toBe(JSON.stringify(derive({ coChanges, packages: [A, other] })));
  });

  it("reads the stored couplings and only the responsibility fields it needs", async () => {
    const reader = {
      internals: () =>
        Promise.resolve({
          responsibilities: {
            modules: [
              {
                affinities: [],
                directory: "src",
                module: "src/a.ts",
                pathAgreesWithRegion: true,
                region: "R1",
                status: "assigned",
              },
              { directory: "src", module: "src/u.ts", status: "unresolved" },
            ],
            regions: [
              {
                id: "R1",
                label: "unread",
                modules: ["src/a.ts"],
                path: {
                  agreement: "matches-path-region",
                  dominantDirectory: { id: "src", modules: 1, share: 1 },
                },
              },
            ],
            relationships: [{ from: "R1", moduleEdges: 1, to: "R2" }],
          },
          topology: { package: { id: "@s/a", root: "packages/a" } },
        }),
      packages: () => [
        { id: "@s/a", internals: true, path: "packages/a", status: "complete" },
        {
          id: "@s/b",
          internals: false,
          path: "packages/b",
          status: "complete",
        },
      ],
      workspaceReport: () =>
        Promise.resolve({
          evolution: {
            couplings: [
              {
                ...coChange("packages/a/src/a.ts", "packages/b/src/b.ts"),
                leftPackage: "@s/a",
                // Seen by one package only: kept all the same.
                verified: false,
              },
            ],
          },
        }),
    } as unknown as LensReader;
    expect(await proximityLens.read(reader)).toEqual({
      coChanges: [coChange("packages/a/src/a.ts", "packages/b/src/b.ts")],
      missing: ["@s/b"],
      packages: [
        {
          id: "@s/a",
          responsibilities: {
            modules: [
              {
                directory: "src",
                module: "src/a.ts",
                pathAgreesWithRegion: true,
                region: "R1",
              },
              { directory: "src", module: "src/u.ts" },
            ],
            regions: [
              {
                id: "R1",
                modules: ["src/a.ts"],
                path: { dominantDirectory: { id: "src" } },
              },
            ],
            relationships: [{ from: "R1", to: "R2" }],
          },
          root: "packages/a",
        },
      ],
    });
  });
});
