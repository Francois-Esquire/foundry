import {
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  RGBAFormat,
} from "three";
import { float, positionWorld } from "three/tsl";
import { expect, it } from "vitest";
import {
  contourChannels,
  contourLevels,
  contourStepField,
  defaultContourSettings,
  type ElevationGrid,
} from "../../src/lib/visualization/contours";
import {
  contourInkNode,
  contourLineNode,
  contourTexturePoint,
  createContourTexture,
  createStepTexture,
  sampleContours,
  sampleSteps,
} from "../../src/web/scene/contour-lines";

/** A sloping field, 5 columns by 3 rows, rising to the east and the south. */
function slope(): ElevationGrid {
  const width = 5;
  const height = 3;
  const elevation = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      elevation[row * width + column] = -1 + column * 0.4 + row * 0.1;
    }
  }
  return { cell: 4, elevation, height, left: -10, top: -6, width };
}

it("builds an antialiased line node for one family, with uniform or fixed widths", () => {
  const line = contourLineNode(positionWorld.x, {
    spacing: { from: 3, to: 9 },
    strength: 1,
    width: 1.5,
  });
  expect(line.isNode).toBe(true);
  const thin = contourLineNode(float(positionWorld.y).mul(0.1), {
    spacing: defaultContourSettings.lines.spacing,
    strength: 0.5,
    width: 0.4,
  });
  expect(thin.isNode).toBe(true);
});

it("bakes the channels into a half-float RGBA texture with rows turned", () => {
  const field = slope();
  const levels = contourLevels();
  const contours = createContourTexture(field, levels);
  const { texture } = contours;
  expect(texture).toBeInstanceOf(DataTexture);
  expect(texture.format).toBe(RGBAFormat);
  expect(texture.type).toBe(HalfFloatType);
  expect([texture.image.width, texture.image.height]).toEqual([5, 3]);
  const data = texture.image.data as Uint16Array;
  expect(data).toHaveLength(5 * 3 * 4);
  const channels = contourChannels(field, levels);
  const rowLength = field.width * 4;
  for (let row = 0; row < field.height; row += 1) {
    const turned = field.height - 1 - row;
    for (let i = 0; i < rowLength; i += 1) {
      expect(data[turned * rowLength + i]).toBe(
        DataUtils.toHalfFloat(channels[row * rowLength + i] ?? 0)
      );
    }
  }
  expect(contours.grid).toEqual({
    cell: 4,
    height: 3,
    left: -10,
    top: -6,
    width: 5,
  });
});

it("rewrites the texels for a new elevation and refuses a different grid", () => {
  const field = slope();
  const contours = createContourTexture(field);
  const { version } = contours.texture;
  const flat = new Float32Array(field.width * field.height).fill(-0.5);
  contours.update(flat);
  expect(contours.texture.version).toBeGreaterThan(version);
  const data = contours.texture.image.data as Uint16Array;
  expect(DataUtils.fromHalfFloat(data[3] ?? 0)).toBeCloseTo(-0.5, 3);
  expect(() => contours.update(new Float32Array(2))).toThrow(
    "expects 15 cells"
  );
});

it("samples the texture by world position and inks minors and majors together", () => {
  const contours = createContourTexture(slope());
  const sample = sampleContours(contours);
  for (const node of Object.values(sample)) {
    expect(node.isNode).toBe(true);
  }
  const textures = new Set<unknown>();
  const ink = contourInkNode(sample);
  expect(ink.isNode).toBe(true);
  ink.traverse((node) => {
    if ("value" in node && node.value instanceof DataTexture) {
      textures.add(node.value);
    }
  });
  expect([...textures]).toEqual([contours.texture]);
  const tuned = contourInkNode(sample, {
    ...defaultContourSettings.lines,
    majorWidth: 3,
  });
  expect(tuned.isNode).toBe(true);
  expect(
    contourTexturePoint(contours.grid, positionWorld.xy.mul(2)).isNode
  ).toBe(true);
});

it("bakes the step coordinate, spacing and downhill into a full-float texture with rows turned", () => {
  const field = slope();
  const levels = [-0.6, -0.2, 0.2];
  const steps = createStepTexture(field, levels, 16);
  const { texture } = steps;
  expect(texture.type).toBe(FloatType);
  expect(texture.format).toBe(RGBAFormat);
  expect([texture.image.width, texture.image.height]).toEqual([5, 3]);
  const data = texture.image.data as Float32Array;
  const baked = contourStepField(field, levels, 16);
  for (let row = 0; row < field.height; row += 1) {
    const turned = field.height - 1 - row;
    for (let column = 0; column < field.width; column += 1) {
      const from = row * field.width + column;
      const to = (turned * field.width + column) * 4;
      expect(data[to]).toBe(baked.coordinate[from]);
      expect(data[to + 1]).toBe(baked.spacing[from]);
      expect(data[to + 2]).toBe(baked.downhill[from * 2]);
      expect(data[to + 3]).toBe(baked.downhill[from * 2 + 1]);
    }
  }
  expect(steps.grid).toEqual({
    cell: 4,
    height: 3,
    left: -10,
    top: -6,
    width: 5,
  });
  const sample = sampleSteps(steps);
  for (const node of Object.values(sample)) {
    expect(node.isNode).toBe(true);
  }
});
