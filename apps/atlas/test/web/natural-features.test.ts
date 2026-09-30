import { describe, expect, it } from "vitest";
import { memberContours } from "../../src/web/belonging";
import { compositionInsideLand } from "../../src/web/composition-placement";
import { classifyFiles } from "../../src/web/district-layout";
import { naturalFeatures } from "../../src/web/natural-features";
import type { AtlasFile, Territory } from "../../src/web/types";

const file = (
  id: string,
  x: number,
  y: number,
  extra: Partial<AtlasFile> = {}
): AtlasFile => ({
  directory: "src",
  id,
  incoming: 0,
  kind: "source",
  outgoing: 0,
  path: id,
  x,
  y,
  ...extra,
});

/** A U-shaped island: two arms joined at the south, water in the middle. */
const territory: Territory = {
  analyzed: true,
  coast: [
    [
      [
        [-60, -60],
        [-20, -60],
        [-20, 20],
        [20, 20],
        [20, -60],
        [60, -60],
        [60, 60],
        [-60, 60],
        [-60, -60],
      ],
    ],
  ],
  color: "#aaa",
  files: [],
  hills: [],
  id: "island",
  label: "Island",
  neighborhoods: [],
  radius: 60,
  shallows: [],
  x: 0,
  y: 0,
};

const west = [
  file("w-junction", -40, -40, { architectureKind: "junction", incoming: 3 }),
  file("w-commons", -40, 40, { architectureKind: "commons", incoming: 9 }),
  file("w-plain", -50, 0),
];
const east = [
  file("e-source", 40, -40, { incoming: 2 }),
  file("e-far", 45, -55, { incoming: 1 }),
];
const lost = [file("lost", 0, 45)];
const region = (id: string, members: AtlasFile[], uncertain = false) => ({
  color: "#678",
  id,
  label: id,
  members,
  polygons: memberContours(members),
  uncertain,
});
const regions = [
  region("west", west),
  region("east", east),
  region("unresolved:lost", lost, true),
];
const evidence = {
  fileIds: {
    "e-source": "e-source",
    lost: "lost",
    "w-junction": "w-junction",
    "w-plain": "w-plain",
  },
  relationships: [
    {
      from: "west",
      moduleEdges: 4,
      sourceModules: ["w-junction"],
      targetModules: ["e-source"],
      to: "east",
    },
    {
      from: "east",
      moduleEdges: 1,
      sourceModules: ["e-source"],
      targetModules: ["w-plain"],
      to: "west",
    },
  ],
  unresolved: [
    {
      candidates: [{ region: "west" }, { region: "east" }, { region: "none" }],
      module: "lost",
    },
  ],
};

describe("natural features", () => {
  const features = naturalFeatures(territory, regions, evidence);

  it("makes lakes from commons files, sized by dependents and fitted to land", () => {
    expect(features.lakes.map((item) => item.file.id)).toEqual(["w-commons"]);
    const [lake] = features.lakes;
    expect(lake?.radius).toBeGreaterThan(3);
    expect(lake?.radius).toBeLessThanOrEqual(6);
    const shore = naturalFeatures(
      territory,
      [region("edge", [file("edge", -58, 0, { architectureKind: "commons" })])],
      { fileIds: {}, relationships: [], unresolved: [] }
    );
    expect(shore.lakes).toEqual([]);
  });

  it("makes marsh from unresolved belonging with drains toward two candidates", () => {
    expect(features.marshes.map((item) => item.region.id)).toEqual([
      "unresolved:lost",
    ]);
    const [marsh] = features.marshes;
    expect(marsh?.drains).toHaveLength(2);
    expect(marsh?.drains[0]?.x).toBeLessThan(0);
    expect(marsh?.drains[1]?.x).toBeGreaterThan(0);
    expect(marsh?.tufts.length).toBeGreaterThan(0);
    for (const tuft of marsh?.tufts ?? []) {
      expect(
        compositionInsideLand(tuft.x, tuft.y, marsh?.region.polygons ?? [])
      ).toBe(true);
    }
  });

  it("routes streams over land between districts and ends them at junctions", () => {
    expect(features.streams.map((s) => [s.from, s.to])).toEqual([
      ["east", "west"],
      ["west", "east"],
    ]);
    const into = features.streams.find((s) => s.from === "west");
    expect(into?.mouth.id).toBe("w-junction");
    expect(into?.points[0]).toMatchObject({ x: 40, y: -40 });
    expect(into?.points.at(-1)).toMatchObject({ x: -40, y: -40 });
    for (const stream of features.streams) {
      for (const point of stream.points) {
        expect(compositionInsideLand(point.x, point.y, territory.coast)).toBe(
          true
        );
      }
    }
    const [wide, narrow] = [...features.streams].sort(
      (a, b) => b.moduleEdges - a.moduleEdges
    );
    expect(wide?.width ?? 0).toBeGreaterThan(narrow?.width ?? 0);
    expect(features.unrouted).toBe(0);
  });

  it("does not mistake an isolated composition junction for a river fork", () => {
    expect(features.confluences).toEqual([]);
  });

  it("counts relationships whose files have no land route", () => {
    const split: Territory = {
      ...territory,
      coast: [
        [
          [
            [-60, -60],
            [-20, -60],
            [-20, 60],
            [-60, 60],
            [-60, -60],
          ],
        ],
        [
          [
            [20, -60],
            [60, -60],
            [60, 60],
            [20, 60],
            [20, -60],
          ],
        ],
      ],
    };
    const result = naturalFeatures(split, regions, evidence);
    expect(result.streams).toEqual([]);
    expect(result.unrouted).toBe(2);
  });
});

describe("file classification", () => {
  it("assigns roles from primitives and composition roots without touching input", () => {
    const files = [
      file("root", 0, 0),
      file("shared", 1, 0),
      file("other", 2, 0),
    ];
    const before = structuredClone(files);
    const classified = classifyFiles(
      {
        architecture: {
          primitives: {
            modules: [
              {
                composition: { scopes: "single-scope" },
                fragmentation: {
                  crossResponsibility: 2,
                  localGroups: 0,
                  packageWide: 0,
                },
                module: "shared",
                symbols: 3,
                unresolvedSymbols: 0,
              },
            ],
          },
          rewiring: {
            composition: [{ compositionRoot: true, module: "root" }],
          },
        } as never,
        fileIds: { root: "root", shared: "shared" },
      },
      files
    );
    expect(classified.map((f) => f.architectureKind)).toEqual([
      "junction",
      "commons",
      undefined,
    ]);
    expect(files).toEqual(before);
  });
});

describe("shared drainage", () => {
  const basin = {
    ...territory,
    coast: [
      [
        [
          [-60, -60],
          [60, -60],
          [60, 60],
          [-60, 60],
          [-60, -60],
        ],
      ],
    ],
  } as Territory;
  const mouth = file("mouth", 35, 25, { architectureKind: "junction" });
  const suppliers = [
    file("a", -40, -25),
    file("b", -35, -10),
    file("c", -30, 10),
  ];
  const places = [
    region("consumer", [mouth]),
    ...suppliers.map((item) => region(item.id, [item])),
  ];
  const links = suppliers.map((item, i) => ({
    from: "consumer",
    moduleEdges: 3 - i,
    sourceModules: ["mouth"],
    targetModules: [item.id],
    to: item.id,
  }));
  const recorded = {
    fileIds: { a: "a", b: "b", c: "c", mouth: "mouth" },
    relationships: links,
    unresolved: [],
  };

  it("shares downstream geometry and sums only the evidence using each trunk", () => {
    const before = structuredClone({ basin, places, recorded });
    const result = naturalFeatures(basin, places, recorded);
    expect(result.streams).toHaveLength(3);
    expect(
      result.rivers.some(
        (run) => run.moduleEdges === 6 && run.streams.length === 3
      )
    ).toBe(true);
    expect(result.confluences.length).toBeGreaterThan(0);
    for (const run of result.rivers) {
      expect(run.moduleEdges).toBe(
        run.streams.reduce((sum, stream) => sum + stream.moduleEdges, 0)
      );
    }
    expect({ basin, places, recorded }).toEqual(before);
    expect(
      naturalFeatures(basin, [...places].reverse(), {
        ...recorded,
        relationships: [...links].reverse(),
      })
    ).toEqual(result);
  });

  it("discloses missing endpoint evidence instead of choosing an unrelated file", () => {
    const result = naturalFeatures(basin, places, { ...recorded, fileIds: {} });
    expect(result.streams).toEqual([]);
    expect(result.omitted.map((item) => item.reason)).toEqual([
      "endpoints",
      "endpoints",
      "endpoints",
    ]);
  });
});
