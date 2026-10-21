import { expect, it } from "vitest";
import {
  clipmapBytes,
  clipmapLayout,
  clipmapLevel,
  defaultClipmapSettings,
  finestNeededLevel,
  levelInset,
  levelsToBake,
  pixelLevel,
} from "../../src/lib/visualization/screen-terrain-clipmap";

const settings = defaultClipmapSettings;

it("doubles each level's texel and covers more than the sea with the coarsest", () => {
  const levels = clipmapLayout(settings, { x: 0, y: 0 });
  expect(levels.map((level) => level.texel)).toEqual([0.25, 0.5, 1, 2, 4, 8]);
  const coarsest = levels.at(-1);
  expect((coarsest?.texel ?? 0) * settings.resolution).toBeGreaterThan(6000);
});

it("snaps a level's centre to whole snaps of its texel, so its grid never swims", () => {
  const level = clipmapLevel(settings, 2, { x: 33.3, y: -97.1 });
  const step = settings.snap * level.texel;
  expect(level.centreX / step).toBe(Math.round(level.centreX / step));
  expect(level.centreY / step).toBe(Math.round(level.centreY / step));
  // Its texel grid lines up with the coarser level's.
  const coarser = clipmapLevel(settings, 3, { x: 33.3, y: -97.1 });
  expect(((level.left - coarser.left) / level.texel) % 1).toBe(0);
  // A pan shorter than half a snap moves nothing.
  const moved = clipmapLevel(settings, 2, { x: 33.3 + step * 0.4, y: -97.1 });
  expect(moved.centreX).toBe(level.centreX);
});

it("asks for the level whose texel matches the pixel, no finer than needed", () => {
  expect(finestNeededLevel(settings, 0.05)).toBe(0);
  expect(finestNeededLevel(settings, 0.25)).toBe(0);
  expect(finestNeededLevel(settings, 1.1)).toBe(2);
  expect(finestNeededLevel(settings, 5)).toBe(4);
  expect(finestNeededLevel(settings, 500)).toBe(settings.levels - 1);
});

it("hands a pixel to a coarser level before the finer one's edge", () => {
  const levels = clipmapLayout(settings, { x: 0, y: 0 });
  const centre = pixelLevel(settings, levels, { footprint: 0.25, x: 0, y: 0 });
  expect(centre).toBe(0);
  // Level 0 ends 128 map units out; a pixel just inside its edge reads level 1.
  const [level0] = levels;
  if (!level0) {
    throw new Error("No finest level");
  }
  const edgeX = (settings.resolution / 2 - settings.edge) * level0.texel;
  expect(levelInset(settings, level0, edgeX, 0)).toBeCloseTo(0);
  expect(
    pixelLevel(settings, levels, { footprint: 0.25, x: edgeX - 0.01, y: 0 })
  ).toBeCloseTo(1, 1);
  // Across the fade the level rises continuously.
  let last = 0;
  for (let x = 0; x <= edgeX; x += 1) {
    const level = pixelLevel(settings, levels, { footprint: 0.25, x, y: 0 });
    expect(level).toBeGreaterThanOrEqual(last);
    expect(level - last).toBeLessThan(0.1);
    last = level;
  }
  // Far out, a coarse level whatever the footprint.
  expect(
    pixelLevel(settings, levels, { footprint: 0.25, x: 3000, y: 0 })
  ).toBeGreaterThanOrEqual(4);
  // Never finer than the view's finest baked level.
  expect(pixelLevel(settings, levels, { footprint: 0.25, x: 0, y: 0 }, 3)).toBe(
    3
  );
});

it("bakes only the levels a view reads whose placement or content changed", () => {
  const levels = clipmapLayout(settings, { x: 0, y: 0 });
  const all = levelsToBake({
    baked: [],
    footprint: 5,
    key: "a",
    levels,
    settings,
  });
  expect(all).toEqual([4, 5]);
  const baked = levels.map((level) => ({
    centreX: level.centreX,
    centreY: level.centreY,
    key: "a",
  }));
  expect(
    levelsToBake({ baked, footprint: 5, key: "a", levels, settings })
  ).toEqual([]);
  expect(
    levelsToBake({ baked, footprint: 5, key: "b", levels, settings })
  ).toEqual([4, 5]);
  // A pan of one snap of level 4 re-centres level 4, not the coarsest.
  const panned = clipmapLayout(settings, { x: 200, y: 0 });
  expect(
    levelsToBake({ baked, footprint: 5, key: "a", levels: panned, settings })
  ).toEqual([4]);
});

it("counts the clipmap's bytes", () => {
  expect(clipmapBytes(settings, 16)).toBe(1024 * 1024 * 6 * 16);
});
