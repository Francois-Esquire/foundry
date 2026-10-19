import { expect, it } from "vitest";
import {
  elevationAtDepth,
  geologyLevels,
  seabedCeiling,
} from "../../src/lib/visualization/geology";
import { defaultSeafloorSettings } from "../../src/lib/visualization/seafloor-features";
import { terrainLevels } from "../../src/lib/visualization/terrain";
import { chartSeafloor } from "../../src/web/layout/chart-seafloor";
import { chartTerrain } from "../../src/web/layout/chart-terrain";
import { loadSpyglass } from "../helpers/reference-spyglass";

it("finds a modest set of seabed features in the reference chart", async () => {
  const data = await loadSpyglass();
  const terrain = chartTerrain(data);
  const seafloor = chartSeafloor(data, terrain);
  expect(seafloor.features.length).toBeGreaterThan(0);
  expect(seafloor.contributions.map(({ id }) => id)).toEqual(
    seafloor.features.map(({ id }) => id)
  );
  for (const kind of ["ridge", "channel", "seamount", "trench"] as const) {
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

it("carves the reference chart's unrelated straits into a shallow platform", async () => {
  const data = await loadSpyglass();
  const structural = chartTerrain(data);
  const platform = elevationAtDepth(40);
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
    expect(channel.elevation).toBeLessThan(elevationAtDepth(1000));
    expect(channel.elevation).toBeGreaterThan(geologyLevels.abyss);
    const contribution = seafloor.contributions.find(
      ({ id }) => id === channel.id
    );
    expect(Math.min(...(contribution?.values ?? []))).toBeLessThan(-0.3);
  }
  // The platform is shallower than any ridge's crest: nothing to raise.
  expect(seafloor.features.filter(({ kind }) => kind === "ridge")).toHaveLength(
    0
  );
});
