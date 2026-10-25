import { DataTexture, DataUtils, RedFormat, RGBAFormat } from "three";
import { expect, it } from "vitest";
import { chartTerrain } from "../../src/web/layout/chart-terrain";
import type { OceanField, RimField } from "../../src/web/layout/ocean-field";
import { createClock } from "../../src/web/scene/clock";
import { createWaterMaterial } from "../../src/web/scene/water-material";
import { createWeatherLayer } from "../../src/web/scene/weather";
import { sceneLayerSolo } from "../../src/web/settings/scene-composition";
import { loadSpyglass } from "../helpers/reference-spyglass";

it("toggles depth and shallows independently on the same material and releases their uniforms", async () => {
  const data = await loadSpyglass();
  const field: OceanField = {
    distances: new Float32Array([0, 20, 80, 200]),
    height: 2,
    land: new Uint8Array(4),
    outside: new Float32Array([0, 0, 30, 100]),
    rims: [],
    scale: 1,
    width: 2,
  };
  data.foundations = [
    {
      id: "dependency:zod",
      lobes: [{ radius: 200, territoryId: "a", weight: 1, x: 0, y: 0 }],
      members: data.territories.slice(0, 2).map((territory) => ({
        direct: true,
        distance: 1,
        territoryId: territory.id,
        weight: 1,
      })),
      name: "zod",
      prominence: 2,
      versions: ["4.0.0"],
      x: 0,
      y: 0,
    },
  ];
  data.foundationGroups = [
    {
      dependencyIds: ["dependency:zod"],
      id: "foundation-group:zod",
      memberIds: data.territories.slice(0, 2).map(({ id }) => id),
    },
  ];
  const rim: RimField = { ...field, extent: data };
  const clock = createClock(0);
  const weather = createWeatherLayer(clock);
  const water = createWaterMaterial({
    chart: data,
    rim,
    sea: data,
    shade: field,
    shore: field,
    terrain: chartTerrain(data),
    weather,
  });
  const { colorNode, normalNode, version } = water.material;
  expect(normalNode?.isNode).toBe(true);
  expect(water.material.roughness).toBe(0.96);
  expect(water.material.roughnessNode).toBeNull();
  const textures = new Set<DataTexture>();
  colorNode?.traverse((node) => {
    if ("value" in node && node.value instanceof DataTexture) {
      textures.add(node.value);
    }
  });
  const shade = [...textures].find(
    (texture) =>
      texture.format === RedFormat && texture.image.width === field.width
  );
  expect(shade).toBeDefined();
  expect(shade?.image.data).toHaveLength(field.width * field.height);
  expect([water.drawn.depth.value, water.drawn.shallows.value]).toEqual([1, 1]);
  for (const [id, expected] of [
    ["sea", [0, 0]],
    ["ocean-depth", [1, 0]],
    ["ocean-shallows", [0, 1]],
    ["subsurface-drift", [0, 0]],
    ["rim-surf", [0, 0]],
  ] as const) {
    water.configure({ hidden: [], solo: sceneLayerSolo(id) });
    expect([water.drawn.depth.value, water.drawn.shallows.value]).toEqual(
      expected
    );
    expect(water.material.colorNode).toBe(colorNode);
    expect(water.material.normalNode).toBe(normalNode);
    expect(water.material.version).toBe(version);
  }
  water.configure({ hidden: ["ocean-shallows"], solo: [] });
  expect([water.drawn.depth.value, water.drawn.shallows.value]).toEqual([1, 0]);
  water.configure({ hidden: [], solo: [] });
  expect([water.drawn.depth.value, water.drawn.shallows.value]).toEqual([1, 1]);

  const terrainTexture = [...textures].find(
    (texture) => texture.format === RGBAFormat
  );
  expect(terrainTexture).toBeDefined();
  const samples = terrainTexture?.image.data as Uint16Array;
  const originalSamples = samples.slice();
  expect(samples.some((value) => value > 0)).toBe(true);
  // An unknown focus leaves each island's own descent, not an empty sea.
  water.configure({ hidden: [], solo: [] }, "missing");
  const bare = samples.slice();
  expect(bare).not.toEqual(originalSamples);
  expect(bare.some((value) => value > 0)).toBe(true);
  water.configure({ hidden: [], solo: [] }, "dependency:zod");
  expect(samples).toEqual(originalSamples);
  // Hiding foundations is the same seabed as focusing on nothing.
  water.configure({ hidden: ["dependency-foundations"], solo: [] });
  expect(samples).toEqual(bare);
  water.configure({ hidden: [], solo: [] }, "", "shelf");
  expect(DataUtils.fromHalfFloat(samples[3] ?? 0)).toBe(1);
  water.configure({ hidden: [], solo: [] });
  expect(samples).toEqual(originalSamples);
  expect(water.material.colorNode).toBe(colorNode);
  expect(water.material.version).toBe(version);
  const releasedTextures = new Set<DataTexture>();
  for (const texture of textures) {
    texture.addEventListener("dispose", () => {
      releasedTextures.add(texture);
    });
  }
  const disposed: string[] = [];
  for (const [name, node] of Object.entries(water.drawn)) {
    node.addEventListener("dispose", () => {
      disposed.push(name);
    });
  }
  water.dispose();
  expect(disposed.toSorted()).toEqual(["depth", "shallows"]);
  expect(releasedTextures).toEqual(textures);
  weather.dispose();
  clock.dispose();
});
