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

it("lowers a plateau's summit by at most the seeded variation", () => {
  const top = sampleAt(island.x, island.y);
  const heights = ["a", "b", "c", "d", "e"].map((seed) =>
    archetypeLandform("plateau", island, seed)(top)
  );
  const full =
    defaultLandformSettings.plateau.formation.height * geologyLevels.land;
  for (const height of heights) {
    expect(height).toBeLessThanOrEqual(full);
    expect(height).toBeGreaterThanOrEqual(
      full * (1 - defaultLandformSettings.variation) - 1e-9
    );
  }
});

it("rises highest on a volcano and keeps a seamount barely above the water", () => {
  const summit = (archetype: (typeof landformArchetypes)[number]) => {
    const landform = archetypeLandform(archetype, island, "seed");
    let highest = 0;
    for (let x = island.x - radius; x <= island.x + radius; x += 1) {
      for (let y = island.y - radius; y <= island.y + radius; y += 1) {
        highest = Math.max(highest, landform(sampleAt(x, y)));
      }
    }
    return highest;
  };
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

it("rings an atoll's lagoon floor with a higher rim, the floor still dry", () => {
  const landform = archetypeLandform("atoll", island, "seed");
  const rim = landform({ inland: 11.4, islandId: "island", x: 0, y: 0 });
  const floor = landform({ inland: 30, islandId: "island", x: 0, y: 0 });
  expect(floor).toBeGreaterThan(0);
  expect(floor).toBeLessThan(rim * 0.5);
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
