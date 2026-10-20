import { expect, it } from "vitest";
import { elevationAtDepth } from "../../src/lib/visualization/geology";
import {
  pathDepth,
  refractedCosine,
} from "../../src/lib/visualization/sdf-water";
import {
  defaultWaterOptics,
  hexFromLinear,
  linearFromHex,
  waterColour,
} from "../../src/web/layout/water-optics";

/** The palette's stops over its sand, as `_geology.md` prints them. */
const stops: [number, string][] = [
  [2.5, "#a8dfd2"],
  [5, "#7ad6ce"],
  [20, "#27b6be"],
  [100, "#1e89a9"],
  [500, "#1d6f9b"],
  [1000, "#18547b"],
  [2000, "#14395d"],
];

const exaggeration = 14;
const sand = linearFromHex(defaultWaterOptics.palette.seabed);

/** World units of water over a seabed at `depth` nominal metres. */
const below = (depth: number) => -elevationAtDepth(depth) * exaggeration;

it("reproduces the palette top-down: the path straight down is the water's depth", () => {
  for (const [depth, hex] of stops) {
    const read = pathDepth(below(depth), 0, exaggeration);
    expect(read).toBeCloseTo(depth, 6);
    expect(hexFromLinear(waterColour(sand, read))).toBe(hex);
  }
});

it("reads a slanted view deeper, and darker, by the refracted path", () => {
  // The chart's own tilt, 40° off the vertical.
  const tilt = (40 * Math.PI) / 180;
  expect(refractedCosine(tilt)).toBeCloseTo(
    Math.cos(Math.asin(Math.sin(tilt) / 1.333)),
    9
  );
  const luminance = ([r, g, b]: readonly number[]) =>
    0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  for (const [depth] of stops) {
    const slanted = pathDepth(below(depth), tilt, exaggeration);
    expect(slanted).toBeGreaterThan(depth);
    expect(luminance(waterColour(sand, slanted))).toBeLessThan(
      luminance(waterColour(sand, depth))
    );
  }
});

it("reads nothing above the water", () => {
  expect(pathDepth(-1, 0.5, exaggeration)).toBe(0);
});
