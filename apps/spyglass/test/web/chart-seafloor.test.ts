import { expect, it } from "vitest";
import {
  elevationAtDepth,
  geologyLevels,
  nominalDepth,
  sampleGrid,
  seabedCeiling,
} from "../../src/lib/visualization/geology";
import { defaultSeafloorSettings } from "../../src/lib/visualization/seafloor-features";
import { terrainLevels } from "../../src/lib/visualization/terrain";
import { chartSeafloor } from "../../src/web/layout/chart-seafloor";
import { chartTerrain } from "../../src/web/layout/chart-terrain";
import { chartWorld } from "../../src/web/layout/chart-world";
import { loadSpyglass } from "../helpers/reference-spyglass";

it("finds a modest set of seabed features in the reference chart", async () => {
  const data = await loadSpyglass();
  const terrain = chartTerrain(data);
  const seafloor = chartSeafloor(data, terrain);
  expect(seafloor.features.length).toBeGreaterThan(0);
  expect(seafloor.contributions.map(({ id }) => id)).toEqual(
    seafloor.features.map(({ id }) => id)
  );
  for (const kind of [
    "canyon",
    "channel",
    "ridge",
    "seamount",
    "spur",
    "trench",
  ] as const) {
    expect(
      seafloor.features.filter((feature) => feature.kind === kind).length
    ).toBeLessThanOrEqual(defaultSeafloorSettings[kind].cap);
  }
  // A ridge stands for a relationship; a channel for its absence.
  const routed = new Set(
    data.routes.map(({ from, to }) => [from, to].sort().join("+"))
  );
  for (const feature of seafloor.features) {
    const pair = [...feature.members].sort().join("+");
    if (feature.kind === "ridge") {
      expect(routed.has(pair)).toBe(true);
      expect(feature.elevation).toBeLessThan(terrainLevels.shelfTop);
    }
    if (feature.kind === "channel") {
      expect(routed.has(pair)).toBe(false);
    }
  }
  // One workspace and no former packages: no trench and no seamount.
  expect(
    seafloor.features.filter(
      ({ kind }) => kind === "trench" || kind === "seamount"
    )
  ).toHaveLength(0);
  const added = new Float32Array(terrain.width * terrain.height);
  for (const contribution of seafloor.contributions) {
    expect(contribution.column + contribution.width).toBeLessThanOrEqual(
      terrain.width
    );
    expect(contribution.row + contribution.height).toBeLessThanOrEqual(
      terrain.height
    );
    for (let r = 0; r < contribution.height; r += 1) {
      for (let c = 0; c < contribution.width; c += 1) {
        const index =
          (contribution.row + r) * terrain.width + contribution.column + c;
        added[index] =
          (added[index] ?? 0) +
          (contribution.values[r * contribution.width + c] ?? 0);
      }
    }
  }
  for (let index = 0; index < added.length; index += 1) {
    if ((terrain.signedDistance[index] ?? 0) < 0) {
      expect(added[index]).toBe(0);
    } else {
      expect(
        (terrain.surface.elevation[index] ?? 0) + (added[index] ?? 0)
      ).toBeLessThan(seabedCeiling);
    }
  }
});

it("raises a seamount where a former package's wreck lies", async () => {
  const data = await loadSpyglass();
  data.formerPackages = [
    {
      id: "@foundry/retired",
      label: "retired",
      lastObserved: "2026-01-01",
      x: 0,
      y: 520,
    },
  ];
  const seafloor = chartSeafloor(data, chartTerrain(data));
  const seamount = seafloor.features.find(({ kind }) => kind === "seamount");
  expect(seamount).toMatchObject({
    geometry: { point: [0, 520], type: "point" },
    id: "seamount:@foundry/retired",
    label: "retired",
    members: ["@foundry/retired"],
  });
});

it("carves the reference chart's unrelated straits into a platform's basins and raises its related saddles over them", async () => {
  const data = await loadSpyglass();
  const structural = chartTerrain(data);
  const platform = elevationAtDepth(150);
  const elevation = Float32Array.from(
    structural.surface.elevation,
    (value, index) =>
      (structural.signedDistance[index] ?? 0) < 0
        ? value
        : Math.max(value, platform)
  );
  const terrain = {
    ...structural,
    surface: { ...structural.surface, elevation },
  };
  const seafloor = chartSeafloor(data, terrain);
  const channels = seafloor.features.filter(({ kind }) => kind === "channel");
  expect(channels.length).toBeGreaterThan(0);
  expect(channels.length).toBeLessThanOrEqual(
    defaultSeafloorSettings.channel.cap
  );
  for (const channel of channels) {
    expect(channel.elevation).toBeLessThan(platform);
    expect(channel.elevation).toBeGreaterThan(elevationAtDepth(1000));
    const contribution = seafloor.contributions.find(
      ({ id }) => id === channel.id
    );
    expect(Math.min(...(contribution?.values ?? []))).toBeLessThan(-0.05);
  }
  // The basins are deeper than every ridge's crest: each related pair is raised.
  const ridges = seafloor.features.filter(({ kind }) => kind === "ridge");
  expect(ridges.length).toBeGreaterThan(0);
  for (const ridge of ridges) {
    expect(ridge.elevation).toBeGreaterThan(platform);
    expect(ridge.elevation).toBeLessThan(geologyLevels.waterLevel);
  }
});

it("cuts a few canyons and raises a few spurs down the reference chart's rim", async () => {
  const data = await loadSpyglass();
  const { platform, seafloor, terrain } = chartWorld(data);
  const { canyon, spur } = defaultSeafloorSettings;
  const falls = seafloor.features.filter(
    ({ kind }) => kind === "canyon" || kind === "spur"
  );
  const canyons = falls.filter(({ kind }) => kind === "canyon");
  expect(canyons.length).toBeGreaterThan(0);
  expect(canyons.length).toBeLessThanOrEqual(canyon.cap);
  expect(falls.length - canyons.length).toBeLessThanOrEqual(spur.cap);
  const heads: [number, number][] = [];
  for (const fall of falls) {
    const points =
      fall.geometry.type === "polyline" ? fall.geometry.points : [];
    const [head] = points;
    const foot = points.at(-1);
    if (!(head && foot)) {
      throw new Error(`${fall.id} has no line`);
    }
    // From the platform's edge down to the escarpment's foot.
    expect(
      nominalDepth(sampleGrid(terrain, platform.seabed, ...head))
    ).toBeLessThan(canyon.head.deep);
    expect(
      nominalDepth(sampleGrid(terrain, platform.seabed, ...foot))
    ).toBeGreaterThan(1500);
    const values =
      seafloor.contributions.find(({ id }) => id === fall.id)?.values ?? [];
    if (fall.kind === "canyon") {
      expect(Math.min(...values)).toBeLessThan(-0.05);
      expect(Math.max(...values)).toBe(0);
    } else {
      expect(Math.max(...values)).toBeGreaterThan(0.02);
      expect(Math.min(...values)).toBe(0);
    }
    // Named for the island nearest its head.
    expect(fall.members).toHaveLength(1);
    heads.push(head);
  }
  // Heads stand well apart, so the escarpment keeps its benches between them.
  for (const [index, [x, y]] of heads.entries()) {
    for (const [ox, oy] of heads.slice(index + 1)) {
      expect(Math.hypot(x - ox, y - oy)).toBeGreaterThan(canyon.spacing / 2);
    }
  }
});
