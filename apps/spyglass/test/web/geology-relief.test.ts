import { expect, it } from "vitest";
import { sampleGrid } from "../../src/lib/visualization/geology";
import { defaultGeologyPreviewSettings } from "../../src/web/scene/geology-layer";
import {
  defaultTerrainLightSettings,
  sunDirection,
  terrainLight,
} from "../../src/web/scene/geology-light";
import {
  bakeRelief,
  type ReliefField,
  reliefSun,
} from "../../src/web/scene/geology-relief";

it("keeps level, open ground at its albedo and shades slopes by the sun from the northwest", () => {
  const level = terrainLight({ normal: [0, 0, 1], relief: 1, sky: 1, sun: 1 });
  for (const channel of level) {
    expect(channel).toBeCloseTo(defaultTerrainLightSettings.exposure, 6);
  }
  // The sun is up the chart and to the west: world -x, +y.
  expect(sunDirection.x).toBeLessThan(0);
  expect(sunDirection.y).toBeGreaterThan(0);
  const toward = terrainLight({
    normal: [-0.2, 0.2, 1],
    relief: 1,
    sky: 1,
    sun: 1,
  });
  const away = terrainLight({
    normal: [0.2, -0.2, 1],
    relief: 1,
    sky: 1,
    sun: 1,
  });
  expect(toward[1]).toBeGreaterThan(level[1]);
  expect(away[1]).toBeLessThan(level[1]);
  // The relief factor deepens a gentle slope's shade, and shade cools it.
  const steeper = terrainLight({
    normal: [0.05, -0.05, 1],
    relief: 6,
    sky: 1,
    sun: 1,
  });
  const gentle = terrainLight({
    normal: [0.05, -0.05, 1],
    relief: 1,
    sky: 1,
    sun: 1,
  });
  expect(steeper[1]).toBeLessThan(gentle[1]);
  const shaded = terrainLight({ normal: [0, 0, 1], relief: 1, sky: 1, sun: 0 });
  expect(shaded[1]).toBeLessThan(0.5);
  expect(shaded[2]).toBeGreaterThan(shaded[0]);
  // Occlusion takes the sky's share.
  const crease = terrainLight({
    normal: [0, 0, 1],
    relief: 1,
    sky: 0.5,
    sun: 1,
  });
  expect(crease[1]).toBeLessThan(level[1]);
});

/** A seabed with one north–south riser at x = 0: a plate to the west at -0.1 over a floor at -0.2. */
function riserField(): ReliefField {
  const width = 40;
  const height = 40;
  const elevation = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      elevation[row * width + column] = column < width / 2 ? -0.1 : -0.2;
    }
  }
  return {
    cell: 4,
    elevation,
    height,
    left: -80,
    signedDistance: new Float32Array(width * height).fill(100),
    top: -80,
    width,
  };
}

it("bakes occlusion at a riser's foot and shade on the side turned from the sun", () => {
  const world = riserField();
  const points = Float32Array.from([-40, 0, -2, 0, 3, 0, 40, 0]);
  const elevation = Float32Array.from({ length: 4 }, (_, id) =>
    sampleGrid(
      world,
      world.elevation,
      points[id * 2] ?? 0,
      points[id * 2 + 1] ?? 0
    )
  );
  const {
    exaggeration,
    light,
    relief: settings,
  } = defaultGeologyPreviewSettings;
  const relief = bakeRelief({
    exaggeration,
    lattice: {
      count: 4,
      elevation,
      gradient: new Float32Array(8),
      points,
    },
    seabedRelief: light.relief.seabed,
    settings,
    sun: reliefSun(sunDirection),
    world,
  });
  const sky = (id: number) => relief.occlusion[id * 2] ?? 0;
  const sun = (id: number) => relief.occlusion[id * 2 + 1] ?? 0;
  // The open plate and the open floor see the whole sky and the sun.
  expect(sky(0)).toBeCloseTo(1, 3);
  expect(sun(0)).toBeCloseTo(1, 3);
  expect(sky(3)).toBeCloseTo(1, 3);
  // The foot of the riser is creased; its lip is not.
  expect(sky(2)).toBeLessThan(sky(3) - 0.1);
  expect(sky(1)).toBeGreaterThan(sky(2));
  expect(relief.curvature[2]).toBeGreaterThan(0);
  expect(relief.curvature[1]).toBeLessThan(0);
  // The sun is to the west, so the floor at the riser's foot is in its shade.
  expect(sun(2)).toBeLessThan(0.6);
  expect(sun(1)).toBeCloseTo(1, 3);
  for (const value of relief.mottle) {
    expect(Math.abs(value)).toBeLessThanOrEqual(1);
  }
});

it("lets a stamp stand on the field for the bake, so a stack's foot darkens", () => {
  const world = riserField();
  const points = Float32Array.from([40, 0, 46, 0]);
  const elevation = Float32Array.from([-0.2, -0.2]);
  const lattice = {
    count: 2,
    elevation,
    gradient: new Float32Array(4),
    points,
  };
  const options = {
    exaggeration: defaultGeologyPreviewSettings.exaggeration,
    lattice,
    settings: defaultGeologyPreviewSettings.relief,
    sun: reliefSun(sunDirection),
    world,
  };
  const bare = bakeRelief(options);
  const stamped = bakeRelief({
    ...options,
    stamps: [{ height: 0.1, radius: 6, x: 40, y: -6 }],
  });
  expect(stamped.occlusion[2] ?? 0).toBeLessThan(bare.occlusion[2] ?? 0);
});

it("casts a riser's shadow past its foot, across the tread below, by the shadow's seabed factor", () => {
  const world = riserField();
  // On the floor east of the riser's foot, a tread's width from its lip.
  const points = Float32Array.from([8, 0]);
  const { exaggeration, light, relief } = defaultGeologyPreviewSettings;
  const sunAt = (seabed: number) =>
    bakeRelief({
      exaggeration,
      lattice: {
        count: 1,
        elevation: Float32Array.from([-0.2]),
        gradient: new Float32Array(2),
        points,
      },
      seabedRelief: light.relief.seabed,
      settings: { ...relief, shadow: { ...relief.shadow, seabed } },
      sun: reliefSun(sunDirection),
      world,
    }).occlusion[1] ?? 0;
  expect(relief.shadow.seabed).toBeGreaterThan(1);
  expect(sunAt(relief.shadow.seabed)).toBeLessThan(sunAt(1) - 0.1);
  expect(sunAt(relief.shadow.seabed)).toBeCloseTo(
    1 - relief.shadow.strength,
    3
  );
});
