import { DataTexture, DataUtils, HalfFloatType, RGBAFormat } from "three";
import { positionWorld } from "three/tsl";
import { expect, it } from "vitest";
import {
  type EmanationField,
  emanationField,
} from "../../src/lib/visualization/archipelago-hull";
import { chartHull } from "../../src/web/layout/chart-hull";
import {
  createEmanationTexture,
  defaultOceanEmanationSettings,
  emanationChannelLayout,
  emanationTexturePoint,
  oceanEmanationNode,
} from "../../src/web/scene/ocean-emanation";
import { chartSeaBounds } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** A small field round one square outline, 12 by 8 cells. */
function squareField(): EmanationField {
  return emanationField(
    [
      {
        points: [
          [-40, -40],
          [40, -40],
          [40, 40],
          [-40, 40],
        ],
      },
    ],
    { height: 400, width: 600 },
    {
      cell: 8,
      padding: 10,
      passes: 0,
      resolution: 12,
      rings: {
        first: 30,
        growth: 10,
        rounding: { radius: 0, reach: 1 },
        softness: 0.3,
      },
      smoothness: 0,
      tolerance: 1,
    }
  );
}

it("builds the chart's hulls and their field once per content, within budget", async () => {
  const data = await loadSpyglass();
  const extent = chartSeaBounds(data);
  const started = performance.now();
  const hull = chartHull(data, extent);
  const elapsed = performance.now() - started;
  // The fixture builds in about 110 ms cold; the bound leaves room for a slow runner.
  expect(elapsed).toBeLessThan(1000);
  expect(hull.outlines).toHaveLength(data.frames.length);
  expect(chartHull(data, extent)).toBe(hull);
  expect(chartHull(data, { ...extent, width: extent.width + 100 })).not.toBe(
    hull
  );
});

it("bakes the field into a half-float RGBA texture with rows turned", () => {
  const field = squareField();
  const { extent, grid, texture } = createEmanationTexture(field);
  expect(texture).toBeInstanceOf(DataTexture);
  expect(texture.format).toBe(RGBAFormat);
  expect(texture.type).toBe(HalfFloatType);
  expect([texture.image.width, texture.image.height]).toEqual([
    field.width,
    field.height,
  ]);
  expect(extent).toEqual({
    height: field.height * field.cell,
    width: field.width * field.cell,
  });
  expect(grid).toEqual({
    cell: field.cell,
    height: field.height,
    left: field.left,
    top: field.top,
    width: field.width,
  });
  expect(emanationChannelLayout).toEqual([
    "ring",
    "gradient",
    "terraced",
    "distance",
  ]);
  const data = texture.image.data as Uint16Array;
  const stride = emanationChannelLayout.length;
  expect(data).toHaveLength(field.width * field.height * stride);
  for (let row = 0; row < field.height; row += 1) {
    const turned = field.height - 1 - row;
    for (let column = 0; column < field.width; column += 1) {
      const from = row * field.width + column;
      const to = (turned * field.width + column) * stride;
      for (const [channel, name] of emanationChannelLayout.entries()) {
        expect(data[to + channel]).toBe(
          DataUtils.toHalfFloat(field[name][from] ?? 0)
        );
      }
    }
  }
  // The top row, the sea's north edge, is outside the outline and at full gradient.
  const top = (field.height - 1) * field.width * stride;
  expect(DataUtils.fromHalfFloat(data[top + 1] ?? 0)).toBe(1);
  expect(DataUtils.fromHalfFloat(data[top + 3] ?? 0)).toBeGreaterThan(0);
});

it("builds the depth bias, ring and gradient nodes over the one texture", () => {
  const { extent, texture } = createEmanationTexture(squareField());
  const emanation = oceanEmanationNode({ extent, texture });
  for (const node of [
    emanation.depthBias,
    emanation.ring,
    emanation.gradient,
    emanation.distance,
    emanation.ringColour,
  ]) {
    expect(node.isNode).toBe(true);
  }
  const textures = new Set<unknown>();
  for (const node of [emanation.depthBias, emanation.ring]) {
    node.traverse((child) => {
      if ("value" in child && child.value instanceof DataTexture) {
        textures.add(child.value);
      }
    });
  }
  expect([...textures]).toEqual([texture]);
  expect(emanationTexturePoint(extent, positionWorld.xy.mul(2)).isNode).toBe(
    true
  );
  emanation.dispose();
});

it("writes every tunable to its uniform", () => {
  const { extent, texture } = createEmanationTexture(squareField());
  const emanation = oceanEmanationNode({ extent, texture });
  const { uniforms } = emanation;
  const defaults = defaultOceanEmanationSettings;
  expect(uniforms.far.value).toBe(defaults.depth.far);
  expect(uniforms.strength.value).toBe(defaults.rings.strength);
  emanation.configure({
    depth: { exponent: 2, far: 800, terracing: 1 },
    rings: {
      colour: "#ff0000",
      fade: 0.2,
      from: 2,
      spacing: { from: 3, to: 9 },
      strength: 0.3,
      width: 1.5,
    },
  });
  expect(uniforms.exponent.value).toBe(2);
  expect(uniforms.far.value).toBe(800);
  expect(uniforms.terracing.value).toBe(1);
  expect(uniforms.fade.value).toBe(0.2);
  expect(uniforms.from.value).toBe(2);
  expect(uniforms.spacingFrom.value).toBe(3);
  expect(uniforms.spacingTo.value).toBe(9);
  expect(uniforms.strength.value).toBe(0.3);
  expect(uniforms.width.value).toBe(1.5);
  expect(uniforms.ringColour.value.getHexString()).toBe("ff0000");
  emanation.dispose();
});
