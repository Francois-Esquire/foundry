import { describe, expect, it } from "vitest";
import { memberContours } from "../../src/web/belonging";
import { compositionInsideLand } from "../../src/web/composition-placement";
import { createLandRouter } from "../../src/web/inland-routing";
import { landmarkFootprint } from "../../src/web/landmark-footprint";
import {
  featureText,
  hitNaturalFeature,
} from "../../src/web/natural-feature-inspection";
import {
  naturalFeatures,
  percentileOrdinal,
} from "../../src/web/natural-features";
import type { SpyglassFile, Territory } from "../../src/web/types";

const file = (
  id: string,
  x: number,
  y: number,
  extra: Partial<SpyglassFile> = {}
): SpyglassFile => ({
  directory: "src",
  highFanIn: false,
  id,
  incoming: 0,
  internalFanIn: 0,
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
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 3,
  hills: [],
  id: "island",
  label: "Island",
  radius: 60,
  responsibilityGroups: undefined,
  shallows: [],
  x: 0,
  y: 0,
};

const west = [
  file("w-junction", -40, -40, { incoming: 3 }),
  file("w-commons", -40, 40, { incoming: 9, internalFanIn: 9 }),
  file("w-plain", -50, 0),
];
const east = [
  file("e-source", 40, -40, { incoming: 2 }),
  file("e-far", 45, -55, { incoming: 1 }),
];
const lost = [file("lost", 0, 45)];
const region = (id: string, members: SpyglassFile[], uncertain = false) => ({
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
  fileRoles: { "w-commons": "commons", "w-junction": "junction" } as const,
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

  it("makes landmarks from commons files, sized by fan-in against the package's cutoff and fitted to land", () => {
    expect(features.landmarks.map((item) => item.file.id)).toEqual([
      "w-commons",
      "w-junction",
    ]);
    const [landmark] = features.landmarks;
    expect(landmark?.radius).toBeGreaterThan(3);
    expect(landmark?.radius).toBeLessThanOrEqual(6);
    const shore = naturalFeatures(
      territory,
      [region("edge", [file("edge", -58, 0)])],
      {
        fileIds: {},
        fileRoles: { edge: "commons" },
        relationships: [],
        unresolved: [],
      }
    );
    expect(shore.landmarks).toEqual([]);
  });

  it("makes marsh from unresolved belonging with drains toward two candidates", () => {
    expect(features.marshes.map((item) => item.region.id)).toEqual([
      "unresolved:lost",
    ]);
    const [marsh] = features.marshes;
    expect(marsh?.drains).toHaveLength(2);
    expect(marsh?.drains[0]?.points.at(-1)?.x).toBeLessThan(0);
    expect(marsh?.drains[1]?.points.at(-1)?.x).toBeGreaterThan(0);
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
  const mouth = file("mouth", 35, 25);
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
    fileRoles: { mouth: "junction" } as const,
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

  it("keeps optional rivers out of hit testing until their layer is on", () => {
    const result = naturalFeatures(basin, places, recorded);
    const [run] = result.rivers;
    const point = run?.points[Math.floor(run.points.length / 2)];
    expect(point).toBeDefined();
    if (!point) {
      return;
    }
    expect(hitNaturalFeature(result, point, 6, false)).toBeUndefined();
    const hit = hitNaturalFeature(result, point, 6, true);
    expect(hit?.kind).toBe("river");
    expect(hit && featureText(hit).detail).toContain("consumer imports from");
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

it("keeps role evidence while leaving file picking to the visible file marks", () => {
  const commons = file("commons", 0, 0);
  const neighbor = file("neighbor", 2, 0);
  const shore = landmarkFootprint(commons, 6, [commons, neighbor]);
  expect(Math.max(...shore.map((point) => point.x))).toBeLessThan(1);
  const features = {
    confluences: [],
    landmarks: [
      {
        basis: "commons" as const,
        consumers: [{ id: "reader", label: "Reader" }],
        cutoff: 0,
        file: commons,
        footprint: shore,
        kind: "summit" as const,
        radius: 6,
      },
    ],
    marshes: [],
    omitted: [],
    rivers: [],
    streams: [],
    unrouted: 0,
  };
  const hit = hitNaturalFeature(features, commons, 6, false);
  expect(hit).toBeUndefined();
  expect(hitNaturalFeature(features, neighbor, 6, false)).toBeUndefined();
  const landmark = features.landmarks.at(0);
  if (!landmark) {
    throw new Error("Missing role evidence");
  }
  expect(featureText({ kind: "landmark", landmark }).detail).toContain(
    "Drawn on by Reader"
  );
});

it("never jumps a sub-grid water gap or routes off-land endpoints", () => {
  const router = createLandRouter([
    [
      [
        [-10, -10],
        [-0.1, -10],
        [-0.1, 10],
        [-10, 10],
        [-10, -10],
      ],
    ],
    [
      [
        [0.1, -10],
        [10, -10],
        [10, 10],
        [0.1, 10],
        [0.1, -10],
      ],
    ],
  ]);
  expect(router({ x: -5, y: 0 }, { x: 5, y: 0 })).toBeUndefined();
  expect(router({ x: 50, y: 0 }, { x: 5, y: 0 })).toBeUndefined();
  expect(createLandRouter([])({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeUndefined();
});

describe("recorded change note", () => {
  const history = { analyzedAt: "2026-09-30T00:00:00Z", historyComplete: true };
  const gate = { eligibleKinds: ["source" as const], minCommitPercentile: 0.9 };

  it("is absent while recorded change is off", () => {
    expect(naturalFeatures(territory, regions, evidence).changeNote).toBe(
      undefined
    );
  });

  it("states the window and the frequent-change gate the lens applied", () => {
    const { changeNote } = naturalFeatures(territory, regions, {
      ...evidence,
      frequentChange: { available: true, files: [], gate, history },
    });
    expect(changeNote).toBe(
      "Full recorded history through 2026-09-30. Complete Git history. Frequent change marks source files at or above the 90th commit percentile among workspace files of the same kind, the hotspot commit gate. Counts describe recorded change, not defects or live activity."
    );
  });

  it("says why there is no recorded change: no history, or a dataset saved before the lens", () => {
    const note = (reason: "no-history" | "not-saved") =>
      naturalFeatures(territory, regions, {
        ...evidence,
        frequentChange: { available: false, reason },
      }).changeNote;
    expect(note("no-history")).toBe(
      "Recorded change unavailable for this survey."
    );
    expect(note("not-saved")).toBe(
      "Run spyglass scan again to include recorded change."
    );
  });

  it("writes percentiles as English ordinals", () => {
    expect(
      [0.9, 0.91, 0.92, 0.93, 0.11, 0.12, 0.13, 1].map(percentileOrdinal)
    ).toEqual([
      "90th",
      "91st",
      "92nd",
      "93rd",
      "11th",
      "12th",
      "13th",
      "100th",
    ]);
  });
});
