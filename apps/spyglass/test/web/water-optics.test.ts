import { float, vec3 } from "three/tsl";
import { expect, it } from "vitest";
import { depthBands } from "../../src/lib/visualization/geology";
import {
  defaultWaterOptics,
  depthPalette,
  hexFromLinear,
  linearFromHex,
  opticalDepth,
  type RGB,
  seabedVisibility,
  transmittance,
  waterColour,
} from "../../src/web/layout/water-optics";
import { waterOpticsNode } from "../../src/web/scene/water-optics";

/** OKLab lightness, chroma and hue in degrees of a linear colour. */
function oklch([r, g, b]: RGB) {
  const l = Math.cbrt(0.412_221_47 * r + 0.536_332_54 * g + 0.051_445_99 * b);
  const m = Math.cbrt(0.211_903_5 * r + 0.680_699_55 * g + 0.107_396_96 * b);
  const s = Math.cbrt(0.088_302_46 * r + 0.281_718_84 * g + 0.629_978_7 * b);
  const lightness = 0.210_454_26 * l + 0.793_617_79 * m - 0.004_072_05 * s;
  const a = 1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_71 * s;
  const bb = 0.025_904_04 * l + 0.782_771_77 * m - 0.808_675_77 * s;
  const hue = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { chroma: Math.hypot(a, bb), hue, lightness };
}

const sand = linearFromHex(defaultWaterOptics.palette.seabed);
const rock = linearFromHex("#4a463f");
const difference = (a: RGB, b: RGB) =>
  Math.max(...a.map((channel, index) => Math.abs(channel - (b[index] ?? 0))));
const depths = [
  0, 1, 2.5, 5, 10, 12.5, 20, 60, 100, 550, 1000, 1500, 2000, 3000, 4000,
];

it("round-trips sRGB hex through linear light", () => {
  for (const hex of ["#000000", "#ffffff", "#f1ead8", "#1e338e"]) {
    expect(hexFromLinear(linearFromHex(hex))).toBe(hex);
  }
});

it("is true metres in shallow water and compressed in deep water", () => {
  expect(opticalDepth(0)).toBe(0);
  expect(opticalDepth(-10)).toBe(0);
  expect(opticalDepth(1)).toBeCloseTo(1, 1);
  expect(opticalDepth(4000)).toBeLessThan(400);
});

it("loses light monotonically with depth, red first and blue last", () => {
  for (let index = 1; index < depths.length; index += 1) {
    const shallower = transmittance(depths[index - 1] ?? 0);
    const deeper = transmittance(depths[index] ?? 0);
    for (const channel of [0, 1, 2] as const) {
      expect(deeper[channel]).toBeLessThan(shallower[channel]);
    }
    expect(seabedVisibility(depths[index] ?? 0)).toBeLessThan(
      seabedVisibility(depths[index - 1] ?? 0)
    );
  }
  const [red, green, blue] = transmittance(27.5);
  expect(red).toBeLessThan(green);
  expect(green).toBeLessThan(blue);
});

it("reads each band over sand darker and bluer with depth, as the legend does", () => {
  const swatches = depthPalette().map((swatch) => ({
    ...swatch,
    ...oklch(linearFromHex(swatch.colour)),
  }));
  expect(swatches.map(({ id }) => id)).toEqual(depthBands.map(({ id }) => id));
  for (let index = 1; index < swatches.length; index += 1) {
    const shallower = swatches[index - 1];
    const deeper = swatches[index];
    expect(deeper?.lightness).toBeLessThan(shallower?.lightness ?? 0);
    expect(deeper?.hue).toBeGreaterThan(shallower?.hue ?? 0);
  }
  const [shoreline, shallows, shelf, slope, deep, trench] = swatches;
  // Hue windows are the reference legend's, read in OKLCH.
  // Pale turquoise: the lightest, with sand showing, and only faintly coloured.
  expect(shoreline?.lightness).toBeGreaterThan(0.85);
  expect(shoreline?.chroma).toBeLessThan(0.06);
  expect(shoreline?.hue).toBeGreaterThan(150);
  // Aqua and teal: cyan hues, clearly coloured.
  expect(shallows?.hue).toBeGreaterThan(185);
  expect(shallows?.hue).toBeLessThan(205);
  expect(shallows?.chroma).toBeGreaterThan(0.06);
  expect(shelf?.hue).toBeGreaterThan(205);
  expect(shelf?.hue).toBeLessThan(225);
  // Cobalt, ultramarine and navy: blues short of violet, darkest in the trench.
  expect(slope?.hue).toBeGreaterThan(225);
  expect(slope?.hue).toBeLessThan(242);
  expect(deep?.hue).toBeGreaterThan(240);
  expect(deep?.hue).toBeLessThan(252);
  expect(deep?.chroma).toBeGreaterThan(0.06);
  expect(trench?.hue).toBeLessThan(258);
  expect(trench?.lightness).toBeLessThan(0.32);
  expect(trench?.chroma).toBeLessThan(deep?.chroma ?? 0);
});

it("keeps green over red at every depth, so no water reads violet", () => {
  for (const swatch of depthPalette()) {
    const [red, green] = linearFromHex(swatch.colour);
    expect(red).toBeLessThan(green);
  }
  for (const depth of depths.filter((each) => each > 0)) {
    for (const seabed of [sand, rock]) {
      const [red, green, blue] = waterColour(seabed, depth);
      expect(red).toBeLessThan(green);
      if (depth >= 20) {
        expect(blue).toBeGreaterThan(green * 0.8);
      }
    }
  }
  const [, scatterGreen, scatterBlue] = defaultWaterOptics.scatter;
  expect(defaultWaterOptics.scatter[0] * 4).toBeLessThan(scatterGreen);
  expect(scatterGreen).toBeLessThan(scatterBlue);
});

it("shows the seabed clearly in the shallows, still on the shelf and not in the deep", () => {
  const middle = defaultWaterOptics.palette.depths;
  expect(seabedVisibility(0)).toBe(1);
  expect(seabedVisibility(middle.shoreline)).toBeGreaterThan(0.8);
  expect(seabedVisibility(middle.shallows)).toBeGreaterThan(0.5);
  expect(seabedVisibility(middle.shelf)).toBeGreaterThan(0.15);
  expect(seabedVisibility(100)).toBeGreaterThan(0.1);
  expect(seabedVisibility(middle.slope)).toBeLessThan(0.03);
  expect(seabedVisibility(middle.deep)).toBeLessThan(0.005);
});

it("lets the seabed's albedo through in the shallows and not in deep water", () => {
  expect(waterColour(sand, 0)).toEqual(sand);
  const shallows = difference(waterColour(sand, 5), waterColour(rock, 5));
  const deep = difference(waterColour(sand, 1500), waterColour(rock, 1500));
  const trench = difference(waterColour(sand, 3000), waterColour(rock, 3000));
  // Pale sand against dark rock: most of the contrast at 5 m, under a
  // twentieth of it at 1,500 m, and next to none in a trench.
  expect(shallows).toBeGreaterThan(0.4);
  expect(deep).toBeLessThan(shallows / 20);
  expect(trench).toBeLessThan(0.005);
});

it("builds the node graph from the CPU model's own constants and tunes it live", () => {
  const water = waterOpticsNode({
    depth: float(125),
    seabedColour: vec3(...sand),
  });
  expect(water.colour.isNode).toBe(true);
  expect(water.visibility.isNode).toBe(true);
  const { uniforms } = water;
  expect(uniforms.absorption.value.toArray()).toEqual([
    ...defaultWaterOptics.absorption,
  ]);
  expect(uniforms.scatter.value.toArray()).toEqual([
    ...defaultWaterOptics.scatter,
  ]);
  expect(uniforms.sky.value.toArray()).toEqual([...defaultWaterOptics.sky]);
  expect(uniforms.twilightColour.value.toArray()).toEqual([
    ...defaultWaterOptics.twilight.colour,
  ]);
  expect(uniforms.knee.value).toBe(defaultWaterOptics.opticalDepth.knee);
  expect(uniforms.exponent.value).toBe(
    defaultWaterOptics.opticalDepth.exponent
  );
  expect(uniforms.reflectance.value).toBe(defaultWaterOptics.reflectance);
  expect(uniforms.shorelineRamp.value).toBe(defaultWaterOptics.shorelineRamp);
  expect(uniforms.twilightFrom.value).toBe(defaultWaterOptics.twilight.from);
  expect(uniforms.twilightLength.value).toBe(
    defaultWaterOptics.twilight.length
  );
  const used = new Set<unknown>();
  water.colour.traverse((node) => {
    used.add(node);
  });
  for (const node of Object.values(uniforms)) {
    expect(used.has(node)).toBe(true);
  }
  water.configure({
    ...defaultWaterOptics,
    absorption: [0.3, 0.05, 0.02],
    twilight: { colour: [0.01, 0.02, 0.05], from: 2000, length: 500 },
  });
  expect(uniforms.absorption.value.toArray()).toEqual([0.3, 0.05, 0.02]);
  expect(uniforms.twilightColour.value.toArray()).toEqual([0.01, 0.02, 0.05]);
  expect(uniforms.twilightFrom.value).toBe(2000);
  const disposed: string[] = [];
  for (const [name, node] of Object.entries(uniforms)) {
    node.addEventListener("dispose", () => {
      disposed.push(name);
    });
  }
  water.dispose();
  expect(disposed.toSorted()).toEqual(Object.keys(uniforms).toSorted());
});
