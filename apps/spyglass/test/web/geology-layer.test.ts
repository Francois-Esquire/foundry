import { Color } from "three";
import { expect, it } from "vitest";
import { nominalDepth } from "../../src/lib/visualization/geology";
import { chartTerrain } from "../../src/web/layout/chart-terrain";
import { terrainRelief } from "../../src/web/layout/terrain-relief";
import { createClock } from "../../src/web/scene/clock";
import {
  buildGeologyPreview,
  createGeologyLayer,
  defaultGeologyPreviewSettings,
  depthKnots,
  plateShade,
} from "../../src/web/scene/geology-layer";
import { createViewState } from "../../src/web/scene/view-state";
import { createWeatherLayer } from "../../src/web/scene/weather";
import {
  defaultChartSettings,
  defaultRenderSettings,
} from "../../src/web/settings/chart-settings";
import {
  defaultSceneComposition,
  detailToggles,
  isSceneLayerVisible,
  sceneCompositionPresets,
} from "../../src/web/settings/scene-composition";
import { chartSeaBounds } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

const view = { height: 600, pixelsPerUnit: 1, width: 800, x: 0, y: 0 };

it("hides the geology preview by default, outside the app bar, and solos it with its preset", () => {
  expect(isSceneLayerVisible(defaultSceneComposition, "geology")).toBe(false);
  expect(
    detailToggles.flatMap(({ layers }) => layers as readonly string[])
  ).not.toContain("geology");
  expect(detailToggles.map(({ label }) => label)).toEqual([
    "Routes",
    "Labels",
    "Details",
    "Ruler",
  ]);
  const preset = sceneCompositionPresets.find(({ id }) => id === "geology");
  expect(preset?.label).toBe("Geology preview");
  const solo = {
    hidden: defaultSceneComposition.hidden,
    solo: preset?.layers ?? [],
  };
  expect(isSceneLayerVisible(solo, "geology")).toBe(true);
  for (const id of ["sea", "relief", "cliffs", "ground", "wrecks"] as const) {
    expect(isSceneLayerVisible(solo, id)).toBe(false);
  }
  const annotated = sceneCompositionPresets.find(
    ({ id }) => id === "annotated-map"
  );
  expect(annotated?.layers).not.toContain("geology");
});

it("keeps the water's surface and the waterline from lifting the sea toward violet or bloom", () => {
  const { shoreline, surface, terraces } = defaultGeologyPreviewSettings;
  const veil = new Color(surface.colour);
  // A navy veil: red under green under blue, and dark.
  expect(veil.r).toBeLessThan(veil.g);
  expect(veil.g).toBeLessThan(veil.b);
  expect(veil.getHSL({ h: 0, l: 0, s: 0 }).l).toBeLessThan(0.2);
  // Foam over the palest water stays under the bloom's threshold.
  const foam = new Color(shoreline.foam.colour);
  const luminance = (colour: Color) =>
    0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
  const palest = 0.8;
  expect(
    palest + (luminance(foam) - palest) * shoreline.foam.strength
  ).toBeLessThan(defaultRenderSettings.bloomThreshold);
  // Plates come in below the shoreline band and are full by the shelf.
  expect(terraces.depth.from).toBeGreaterThanOrEqual(5);
  expect(terraces.depth.to).toBeLessThanOrEqual(20);
});

it("reads nominal depth from elevation through the depth bands' knots", () => {
  const knots = depthKnots();
  const depthAt = (elevation: number) => {
    let depth = 0;
    for (let index = 1; index < knots.length; index += 1) {
      const upper = knots[index - 1];
      const lower = knots[index];
      if (upper && lower) {
        const t = Math.min(
          1,
          Math.max(
            0,
            (upper.elevation - elevation) / (upper.elevation - lower.elevation)
          )
        );
        depth += t * (lower.depth - upper.depth);
      }
    }
    return depth;
  };
  for (let elevation = 0.2; elevation >= -1.4; elevation -= 0.01) {
    expect(depthAt(elevation)).toBeCloseTo(nominalDepth(elevation), 6);
  }
});

it("builds one refined terrain mesh from the fixture, land above the water and sea below it", async () => {
  const data = await loadSpyglass();
  const clock = createClock(0);
  const weather = createWeatherLayer(clock);
  const extent = chartSeaBounds(data);
  const preview = buildGeologyPreview({ data, extent, weather });
  const { geometry, lattice } = preview;
  const { world } = preview.chart;
  const { refine } = defaultGeologyPreviewSettings.lattice;
  const coarse = world.width * world.height;
  expect(lattice.refined).toBeGreaterThan(0);
  expect(lattice.count).toBeGreaterThan(coarse);
  expect(lattice.index).toHaveLength(
    ((world.width - 1) * (world.height - 1) - lattice.refined) * 6 +
      lattice.refined * refine * refine * 6
  );
  expect(lattice.index.reduce((most, id) => Math.max(most, id), 0)).toBe(
    lattice.count - 1
  );
  const position = geometry.getAttribute("position");
  expect(position.count).toBe(lattice.count);
  for (const name of [
    "normal",
    "elevation",
    "albedo",
    "occlusion",
    "contour",
    "inspection",
  ]) {
    expect(geometry.getAttribute(name).count).toBe(lattice.count);
  }
  // Occlusion is a share of the sky and of the sun, and some creases and
  // shade are baked; the seabed's albedo varies, not one sand.
  const occlusion = geometry.getAttribute("occlusion");
  let creased = 0;
  let shaded = 0;
  for (let id = 0; id < lattice.count; id += 1) {
    const [sky, sun] = [occlusion.getX(id), occlusion.getY(id)];
    expect(sky).toBeGreaterThanOrEqual(0);
    expect(sky).toBeLessThanOrEqual(1);
    expect(sun).toBeGreaterThanOrEqual(0);
    expect(sun).toBeLessThanOrEqual(1);
    creased += sky < 0.9 ? 1 : 0;
    shaded += sun < 0.9 ? 1 : 0;
  }
  expect(creased).toBeGreaterThan(0);
  expect(shaded).toBeGreaterThan(0);
  const albedo = geometry.getAttribute("albedo");
  let palest = 0;
  let darkest = 1;
  for (let id = 0; id < lattice.count; id += 1) {
    const depth = nominalDepth(lattice.elevation[id] ?? 0);
    if ((lattice.owner[id] ?? -1) < 0 && depth > 5 && depth < 100) {
      palest = Math.max(palest, albedo.getY(id));
      darkest = Math.min(darkest, albedo.getY(id));
    }
  }
  expect(palest - darkest).toBeGreaterThan(0.2);
  // The outer ring reaches the sea's extent.
  expect(position.getX(0)).toBeCloseTo(-extent.width / 2, 3);
  expect(position.getY(0)).toBeCloseTo(extent.height / 2, 3);
  const water = preview.surface.position.z;
  expect(water).toBe(0);
  // An island's land stands over the water; a lagoon inside it is owned by
  // the island yet under the water, so the optics shade it as water. The
  // open sea is all under the water.
  let land = 0;
  let lagoon = 0;
  for (let id = 0; id < lattice.count; id += 1) {
    const z = position.getZ(id);
    if ((lattice.owner[id] ?? -1) < 0) {
      expect(z).toBeLessThan(water);
    } else if (z > water) {
      land += 1;
    } else {
      lagoon += 1;
      expect(lattice.elevation[id]).toBeLessThan(0);
    }
  }
  expect(land).toBeGreaterThan(lagoon);
  // Every island owns land, and the summit stands at the exaggerated height.
  expect(new Set(lattice.owner).size).toBe(data.territories.length + 1);
  let highest = 0;
  for (let id = 0; id < lattice.count; id += 1) {
    highest = Math.max(highest, position.getZ(id));
  }
  expect(highest).toBeLessThanOrEqual(
    defaultGeologyPreviewSettings.exaggeration
  );
  expect(highest).toBeGreaterThan(
    defaultGeologyPreviewSettings.exaggeration / 2
  );
  // Normals point up and away from the slope.
  const normal = geometry.getAttribute("normal");
  for (let id = 0; id < lattice.count; id += 997) {
    expect(normal.getZ(id)).toBeGreaterThan(0);
  }
  // Every triangle, coarse, refined and on the stretched outer ring, faces
  // up: wound anticlockwise in world space, as a front face is.
  let clockwise = 0;
  for (let at = 0; at < lattice.index.length; at += 3) {
    const [a = 0, b = 0, c = 0] = lattice.index.subarray(at, at + 3);
    const abx = position.getX(b) - position.getX(a);
    const aby = position.getY(b) - position.getY(a);
    const acx = position.getX(c) - position.getX(a);
    const acy = position.getY(c) - position.getY(a);
    if (abx * acy - aby * acx <= 0) {
      clockwise += 1;
    }
  }
  expect(clockwise).toBe(0);
  preview.dispose();
  weather.dispose();
  clock.dispose();
});

it("shows geology inspections on the preview and leaves the sea's water for them", async () => {
  const data = await loadSpyglass();
  const clock = createClock(0);
  const weather = createWeatherLayer(clock);
  const preview = buildGeologyPreview({
    data,
    extent: chartSeaBounds(data),
    weather,
  });
  const values = preview.geometry.getAttribute("inspection");
  preview.inspect("landform");
  const greys = new Set<number>();
  for (let id = 0; id < preview.lattice.count; id += 1) {
    if ((preview.lattice.owner[id] ?? -1) >= 0) {
      greys.add(values.getX(id));
    } else {
      expect(values.getX(id)).toBe(0);
    }
  }
  const archetypes = new Set(
    [...preview.chart.landforms.values()].map(({ archetype }) => archetype)
  );
  expect(greys.size).toBe(archetypes.size);
  for (const inspection of [
    "world-elevation",
    "depth-band",
    "seafloor",
  ] as const) {
    preview.inspect(inspection);
    let lowest = 1;
    let highest = 0;
    for (let id = 0; id < preview.lattice.count; id += 1) {
      lowest = Math.min(lowest, values.getX(id));
      highest = Math.max(highest, values.getX(id));
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(highest).toBeLessThanOrEqual(1);
    expect(highest).toBeGreaterThan(lowest);
  }
  const terrain = chartTerrain(data);
  const relief = terrainRelief(terrain, terrain.surface, "seafloor");
  expect(relief[3]).toBe(0);
  expect(terrainRelief(terrain, terrain.surface, "shelf")[3]).toBe(1);
  preview.dispose();
  weather.dispose();
  clock.dispose();
});

it("builds the layer only once it is shown and releases everything on dispose", async () => {
  const data = await loadSpyglass();
  const clock = createClock(0);
  const weather = createWeatherLayer(clock);
  const layer = createGeologyLayer({
    data,
    extent: chartSeaBounds(data),
    weather,
  });
  const state = createViewState(data, defaultChartSettings);
  layer.update?.(view, state, 0);
  expect(layer.group?.children).toHaveLength(0);
  expect(layer.stats?.()).toEqual({});
  state.settings = {
    ...state.settings,
    composition: { hidden: [], solo: ["geology"] },
  };
  layer.update?.(view, state, 0);
  const preview = layer.preview();
  expect(layer.group?.children).toEqual([preview.group]);
  layer.update?.(view, state, 1);
  expect(layer.preview()).toBe(preview);
  expect(layer.stats?.()).toEqual({
    triangles: preview.lattice.index.length / 3,
    vertices: preview.lattice.count,
  });
  const released: string[] = [];
  preview.geometry.addEventListener("dispose", () => released.push("terrain"));
  preview.material.addEventListener("dispose", () => released.push("material"));
  preview.surface.geometry.addEventListener("dispose", () =>
    released.push("surface")
  );
  const surfaceMaterial = preview.surface.material;
  if (Array.isArray(surfaceMaterial)) {
    throw new Error("The surface has one material");
  }
  surfaceMaterial.addEventListener("dispose", () =>
    released.push("surface material")
  );
  layer.dispose();
  expect(released.toSorted()).toEqual([
    "material",
    "surface",
    "surface material",
    "terrain",
  ]);
  weather.dispose();
  clock.dispose();
});

it("shades each plate as cut paper: a pale lip at the tread's edge, risers by their bearing to the sun", () => {
  const { terraces } = defaultGeologyPreviewSettings;
  const level: [number, number, number] = [0, 0, 1];
  // World x right and y up: the sun is to the northwest.
  const away: [number, number, number] = [0.1, -0.1, 1];
  const toward: [number, number, number] = [-0.1, 0.1, 1];
  const shade = (
    coordinate: number,
    normal: readonly [number, number, number],
    depth = 50,
    footprint = 0.02
  ) => plateShade({ coordinate, depth, footprint, normal });
  // Each tread sits on a half-integer of the coordinate and keeps its light.
  const tread = 7.5;
  expect(shade(tread, level)).toBe(1);
  expect(shade(tread, away)).toBe(1);
  // Just below the tread, the lip: lifted all round, most facing the sun.
  const lip = tread - (terraces.tread.to + terraces.lip.width / 2);
  expect(shade(lip, level)).toBeCloseTo(1 + terraces.lip.strength, 6);
  expect(shade(lip, away)).toBeGreaterThan(1);
  expect(shade(lip, away)).toBeLessThan(shade(lip, toward));
  // Past the lip, the riser: darker turned from the sun, lighter facing it.
  const riser = tread - 0.3;
  expect(shade(riser, away)).toBeLessThan(1 - terraces.riser.away / 2);
  expect(shade(riser, toward)).toBeGreaterThan(1);
  expect(shade(riser, level)).toBe(1);
  // The lip ends crisply, within a pixel or two of the coordinate on screen.
  expect(shade(lip - terraces.lip.width, level)).toBe(1);
  // No plates in the shoreline's water, nor where the field is flat on screen.
  expect(shade(lip, level, 2)).toBe(1);
  expect(shade(riser, away, 50, 0)).toBe(1);
  // Deeper plates swing further, so the escarpment reads through the water,
  // yet never below black.
  expect(shade(lip, level, terraces.deep.to)).toBeGreaterThan(
    shade(lip, level)
  );
  expect(shade(riser, away, terraces.deep.to)).toBeGreaterThanOrEqual(0);
  expect(shade(riser, away, terraces.deep.to)).toBeLessThan(shade(riser, away));
});
