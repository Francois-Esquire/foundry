import { expect, it } from "vitest";
import {
  geologyLevels,
  landformArchetypes,
  rampLandform,
} from "../../src/lib/visualization/geology";
import {
  archetypeLandform,
  classifyLandform,
  defaultLandformSettings,
  type LandformMetrics,
  type LandformParams,
  landformFor,
  terracedProfile,
} from "../../src/lib/visualization/landforms";

/** A round island of radius 30 at (100, -40), its hubs off centre. */
const island: LandformParams = {
  axis: [Math.SQRT1_2, Math.SQRT1_2],
  breadth: 22,
  depth: 30,
  length: 34,
  peaks: [
    { weight: 1, x: 110, y: -36 },
    { weight: 0.6, x: 88, y: -50 },
    { weight: 0.3, x: 96, y: -24 },
  ],
  x: 100,
  y: -40,
};
const radius = 30;

/** A land sample on the round island, inland from its circular coast. */
function sampleAt(x: number, y: number) {
  const inland = Math.max(0, radius - Math.hypot(x - island.x, y - island.y));
  return { inland, islandId: "island", x, y };
}

const profileParams = {
  beach: 3,
  beachHeight: 0.05,
  beachLip: 0.4,
  height: 0.9,
  minimumRiser: 2,
  reach: 30,
  riser: 0.3,
  softness: 0.05,
  terraces: 3,
};

const step = 0.05;
/** The steepest rise any landform takes, elevation per map unit; bounds a neighbour's jump. */
const steepest = 0.6;

it("raises the terraced profile from 0 at the coast to its summit, and never past land", () => {
  const profile = terracedProfile(profileParams);
  expect(profile(0)).toBe(0);
  expect(profile(30)).toBeCloseTo(0.9, 6);
  expect(profile(80)).toBeCloseTo(0.9, 6);
  const tall = terracedProfile({ ...profileParams, height: 5 });
  for (let inland = 0; inland <= 60; inland += step) {
    expect(tall(inland)).toBeLessThanOrEqual(geologyLevels.land);
    expect(profile(inland)).toBeGreaterThanOrEqual(0);
  }
});

it("steps the profile in flat treads and steep escarpments, continuously", () => {
  const profile = terracedProfile(profileParams);
  const slopes: number[] = [];
  for (let inland = 3; inland < 30; inland += step) {
    const jump = profile(inland + step) - profile(inland);
    expect(Math.abs(jump)).toBeLessThanOrEqual(steepest * step);
    slopes.push(jump / step);
  }
  const mean = slopes.reduce((sum, slope) => sum + slope, 0) / slopes.length;
  const treads = slopes.filter((slope) => slope <= 0.1 * mean);
  const risers = slopes.filter((slope) => slope >= 2 * mean);
  expect(treads.length).toBeGreaterThan(slopes.length * 0.4);
  expect(risers.length).toBeGreaterThan(slopes.length * 0.1);
  expect(Math.min(...slopes)).toBeGreaterThanOrEqual(0);
});

it("keeps an escarpment at least the minimum riser wide", () => {
  const profile = terracedProfile({
    ...profileParams,
    minimumRiser: 6,
    riser: 0.01,
  });
  let steepestJump = 0;
  for (let inland = 3; inland < 30; inland += step) {
    steepestJump = Math.max(
      steepestJump,
      (profile(inland + step) - profile(inland)) / step
    );
  }
  // A smooth rise of 0.85 / 3 over 6 units is at most 1.5 × its mean slope.
  expect(steepestJump).toBeLessThanOrEqual((1.5 * (0.85 / 3)) / 6 + 1e-3);
});

it("lays a flat beach bench at the coast before the first escarpment", () => {
  const profile = terracedProfile(profileParams);
  // The seaward face rises over the first 40% of the beach.
  expect(profile(0.6)).toBeGreaterThan(0);
  expect(profile(0.6)).toBeLessThan(0.05);
  // Then the bench holds level sand to the escarpment's foot.
  expect(profile(1.2)).toBeCloseTo(0.05, 6);
  expect(profile(2)).toBeCloseTo(0.05, 6);
  expect(profile(3)).toBeCloseTo(0.05, 6);
  expect(profile(3.5)).toBeGreaterThan(0.05);
});

it("makes every archetype 0 at the coast, within land, and continuous", () => {
  for (const archetype of landformArchetypes) {
    const landform = archetypeLandform(archetype, island, "seed");
    for (let angle = 0; angle < 2 * Math.PI; angle += 0.3) {
      const x = island.x + radius * Math.cos(angle);
      const y = island.y + radius * Math.sin(angle);
      expect(landform({ inland: 0, islandId: "island", x, y })).toBe(0);
    }
    for (const angle of [0, 0.7, 1.9, 3.3, 4.6]) {
      let previous = landform(sampleAt(island.x - radius, island.y));
      for (let t = -radius; t <= radius; t += step) {
        const x = island.x + t * Math.cos(angle);
        const y = island.y + t * Math.sin(angle);
        const height = landform(sampleAt(x, y));
        expect(height).toBeGreaterThanOrEqual(0);
        expect(height).toBeLessThanOrEqual(geologyLevels.land);
        if (t > -radius) {
          expect(Math.abs(height - previous)).toBeLessThanOrEqual(
            steepest * step
          );
        }
        previous = height;
      }
    }
  }
});

it("builds the same landform from the same seed", () => {
  for (const archetype of landformArchetypes) {
    const one = archetypeLandform(archetype, island, "a");
    const again = archetypeLandform(archetype, island, "a");
    for (let t = -radius; t <= radius; t += 1) {
      const at = sampleAt(island.x + t, island.y - t / 2);
      expect(one(at)).toBe(again(at));
    }
  }
});

it("varies the land with the seed", () => {
  const one = archetypeLandform("plateau", island, "a");
  const other = archetypeLandform("plateau", island, "b");
  let differs = false;
  for (let t = -radius; t <= radius; t += 1) {
    const at = sampleAt(island.x + t, island.y + t / 3);
    differs ||= one(at) !== other(at);
  }
  expect(differs).toBe(true);
});

/** The highest a landform rises over the round island, on a 1-unit grid. */
function summitOf(landform: (sample: ReturnType<typeof sampleAt>) => number) {
  let highest = 0;
  for (let x = island.x - radius; x <= island.x + radius; x += 1) {
    for (let y = island.y - radius; y <= island.y + radius; y += 1) {
      highest = Math.max(highest, landform(sampleAt(x, y)));
    }
  }
  return highest;
}

it("lowers a plateau's summit by at most the seeded variation", () => {
  const full =
    defaultLandformSettings.plateau.formation.height * geologyLevels.land;
  for (const seed of ["a", "b", "c", "d", "e"]) {
    const height = summitOf(archetypeLandform("plateau", island, seed));
    expect(height).toBeLessThanOrEqual(full);
    expect(height).toBeGreaterThanOrEqual(
      full * (1 - defaultLandformSettings.variation) - 1e-9
    );
  }
});

it("steps a sculpted relief, so no escarpment is a fixed distance inland", () => {
  for (const archetype of landformArchetypes) {
    const landform = archetypeLandform(archetype, island, "seed");
    const heights: number[] = [];
    for (let angle = 0; angle < 2 * Math.PI; angle += 0.05) {
      const reach = radius - 8;
      heights.push(
        landform(
          sampleAt(
            island.x + reach * Math.cos(angle),
            island.y + reach * Math.sin(angle)
          )
        )
      );
    }
    // Eight units inland, the land stands on different steps round the island.
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.1);
  }
});

it("keeps the sculpted treads level and the escarpments steep", () => {
  const landform = archetypeLandform("plateau", island, "seed");
  const slopes: number[] = [];
  for (const angle of [0, 0.7, 1.9, 3.3, 4.6]) {
    for (let t = 2; t < radius; t += step) {
      const along = (r: number) =>
        landform(
          sampleAt(
            island.x + (radius - r) * Math.cos(angle),
            island.y + (radius - r) * Math.sin(angle)
          )
        );
      slopes.push(Math.abs(along(t + step) - along(t)) / step);
    }
  }
  const mean = slopes.reduce((sum, slope) => sum + slope, 0) / slopes.length;
  expect(slopes.filter((slope) => slope <= 0.2 * mean).length).toBeGreaterThan(
    slopes.length * 0.4
  );
  expect(slopes.filter((slope) => slope >= 2 * mean).length).toBeGreaterThan(
    slopes.length * 0.05
  );
});

it("narrows the beach on a small islet, so it keeps land behind its sand", () => {
  const landform = archetypeLandform("plateau", island, "seed");
  const bench =
    defaultLandformSettings.beach.height * geologyLevels.land + 1e-6;
  /** The share of a 10-unit islet's land that is beach bench. */
  const sand = (pieceDepth?: number) => {
    let land = 0;
    let beach = 0;
    for (let x = -10; x <= 10; x += 0.5) {
      for (let y = -10; y <= 10; y += 0.5) {
        const inland = 10 - Math.hypot(x, y);
        if (inland > 0) {
          land += 1;
          const height = landform({
            inland,
            islandId: "island",
            pieceDepth,
            x: island.x + 60 + x,
            y: island.y + y,
          });
          beach += Number(height <= bench);
        }
      }
    }
    return beach / land;
  };
  expect(sand(10)).toBeLessThan(sand());
  expect(sand(10)).toBeLessThan(0.6);
  // The islet still rises no higher than its own depth carries it.
  expect(summitOf(landform)).toBeGreaterThan(
    landform({ inland: 10, islandId: "island", pieceDepth: 10, x: 0, y: 0 })
  );
});

it("cuts a valley up from each bay, below the land beside it", () => {
  const bay = { depth: 8, x: island.x + radius, y: island.y };
  const bayed = { ...island, outlets: [bay] };
  for (const seed of ["a", "b", "c"]) {
    const landform = archetypeLandform("plateau", bayed, seed);
    const plain = archetypeLandform("plateau", island, seed);
    const inland = 14;
    const course = sampleAt(island.x + radius - inland, island.y);
    expect(landform(course)).toBeLessThan(plain(course));
  }
});

it("rises highest on a volcano and keeps a seamount barely above the water", () => {
  const summit = (archetype: (typeof landformArchetypes)[number]) =>
    summitOf(archetypeLandform(archetype, island, "seed"));
  expect(summit("seamount")).toBeLessThan(0.25);
  expect(summit("volcanic")).toBeGreaterThan(summit("plateau"));
  expect(summit("plateau")).toBeGreaterThan(summit("cluster"));
});

it("sinks a crater at the volcano's crown below its lip", () => {
  const landform = archetypeLandform("volcanic", island, "seed");
  const [hub] = island.peaks;
  const ventX = ((hub?.x ?? 0) + island.x) / 2;
  const ventY = ((hub?.y ?? 0) + island.y) / 2;
  const crater = island.depth * defaultLandformSettings.volcanic.crater;
  const floor = landform(sampleAt(ventX, ventY));
  const lip = landform(sampleAt(ventX + crater, ventY));
  expect(floor).toBeGreaterThan(0);
  expect(floor).toBeLessThan(lip);
});

it("rings an atoll's dry lagoon floor with motus joined by sandy saddles", () => {
  const landform = archetypeLandform("atoll", island, "seed");
  const bench = defaultLandformSettings.beach.height * geologyLevels.land;
  const rim = island.depth * defaultLandformSettings.atoll.formation.reach;
  const heights: number[] = [];
  for (let x = -200; x <= 200; x += 0.5) {
    heights.push(landform({ inland: rim, islandId: "island", x, y: 0 }));
  }
  const floor = landform({ inland: 30, islandId: "island", x: 0, y: 0 });
  expect(floor).toBeGreaterThan(0);
  expect(floor).toBeLessThanOrEqual(bench + 1e-6);
  // Motus stand well above the bench; the saddles between them are sand.
  expect(Math.max(...heights)).toBeGreaterThan(4 * bench);
  expect(Math.min(...heights)).toBeLessThanOrEqual(bench + 1e-6);
});

it("runs a ridge's crest along its axis, high along it and low across it", () => {
  const landform = archetypeLandform("ridge", island, "seed");
  const [ax, ay] = island.axis;
  const along = landform(sampleAt(island.x + 8 * ax, island.y + 8 * ay));
  const across = landform(sampleAt(island.x - 16 * ay, island.y + 16 * ax));
  expect(along).toBeGreaterThan(across);
});

it("raises a cluster's knolls at its hubs above the low ground between them", () => {
  const landform = archetypeLandform("cluster", island, "seed");
  const [hub] = island.peaks;
  const knoll = landform(sampleAt(hub?.x ?? 0, hub?.y ?? 0));
  const between = landform(sampleAt(island.x - 12, island.y + 14));
  expect(knoll).toBeGreaterThan(between);
  expect(between).toBeGreaterThan(0);
});

const plateauMetrics: LandformMetrics = {
  coastPieces: 1,
  elongation: 1.1,
  files: 80,
  hubDominance: 1.2,
  hubRim: 0.4,
  hubs: 5,
};

it("classifies every formation, in order of precedence", () => {
  const cases: [Partial<LandformMetrics>, string][] = [
    [{ coastPieces: 5, elongation: 3, files: 4 }, "seamount"],
    [{ coastPieces: 3, elongation: 3, hubRim: 1.2 }, "cluster"],
    [{ elongation: 1.8, hubDominance: 3, hubRim: 1.2 }, "ridge"],
    [{ hubDominance: 3, hubRim: 0.9 }, "atoll"],
    [{ hubDominance: 2 }, "volcanic"],
    [{}, "plateau"],
  ];
  for (const [change, archetype] of cases) {
    expect(classifyLandform({ ...plateauMetrics, ...change })).toBe(archetype);
  }
  const reached = new Set(
    cases.map(([change]) => classifyLandform({ ...plateauMetrics, ...change }))
  );
  expect([...reached].sort()).toEqual([...landformArchetypes].sort());
});

it("needs hubs to ring an atoll or crown a volcano", () => {
  expect(classifyLandform({ ...plateauMetrics, hubRim: 1.2, hubs: 2 })).toBe(
    "plateau"
  );
  expect(
    classifyLandform({ ...plateauMetrics, hubDominance: 4, hubs: 0 })
  ).toBe("plateau");
});

it("classifies deterministically", () => {
  const metrics = { ...plateauMetrics, hubDominance: 1.85 };
  expect(classifyLandform(metrics)).toBe(classifyLandform({ ...metrics }));
});

it("dispatches by island and falls back to the ramp", () => {
  const landform = landformFor(
    new Map([["volcano", { archetype: "volcanic" as const, params: island }]])
  );
  const volcano = archetypeLandform("volcanic", island, "volcano");
  const at = sampleAt(island.x + 4, island.y + 1);
  expect(landform({ ...at, islandId: "volcano" })).toBe(volcano(at));
  const ramp = rampLandform(40);
  for (const inland of [0, 10, 25, 60]) {
    const sample = { inland, islandId: "elsewhere", x: 0, y: 0 };
    expect(landform(sample)).toBe(ramp(sample));
  }
});
