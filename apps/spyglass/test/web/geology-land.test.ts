import { Color } from "three";
import { expect, it } from "vitest";
import {
  defaultLandSurfaceSettings,
  detailFade,
  landCover,
  landPalette,
  landTone,
  strataShade,
} from "../../src/web/scene/geology-land";

const settings = defaultLandSurfaceSettings;
const fine = { elevation: 1e-4, slope: 1e-4 };

it("cuts the land into sand, wet sand and escarpment along crisp edges", () => {
  // The beach bench, level at 0.04, is dry sand; the waterline is wet.
  const bench = landCover({ elevation: 0.04, footprint: fine, slope: 0 });
  expect(bench).toEqual({ beach: 1, riser: 0, wet: 0 });
  const waterline = landCover({
    elevation: 0.003,
    footprint: fine,
    slope: 0.02,
  });
  expect(waterline.beach).toBe(1);
  expect(waterline.wet).toBe(1);
  const halfway = landCover({
    elevation: (settings.beach.wet.from + settings.beach.wet.to) / 2,
    footprint: fine,
    slope: 0,
  });
  expect(halfway.wet).toBeCloseTo(0.5, 6);
  // A tread above the sand keeps its tone; a riser's middle is escarpment.
  const tread = landCover({ elevation: 0.3, footprint: fine, slope: 0.03 });
  expect(tread).toEqual({ beach: 0, riser: 0, wet: 0 });
  const riser = landCover({ elevation: 0.3, footprint: fine, slope: 0.13 });
  expect(riser.riser).toBe(1);
  // The sand covers the first escarpment's foot up to its level line.
  const foot = landCover({ elevation: 0.05, footprint: fine, slope: 0.13 });
  expect(foot.beach).toBe(1);
  // Each edge turns within a pixel and a half of its value on screen.
  const pixel = 0.002;
  const edge = settings.escarpment.slope;
  const across = (slope: number) =>
    landCover({
      elevation: 0.3,
      footprint: { elevation: pixel, slope: pixel },
      slope,
    }).riser;
  expect(across(edge - 0.75 * pixel)).toBe(0);
  expect(across(edge)).toBeCloseTo(0.5, 6);
  expect(across(edge + 0.75 * pixel)).toBe(1);
  const { top } = settings.beach;
  const level = (elevation: number) =>
    landCover({
      elevation,
      footprint: { elevation: pixel, slope: pixel },
      slope: 0,
    }).beach;
  expect(level(top - 0.75 * pixel)).toBe(1);
  expect(level(top + 0.75 * pixel)).toBe(0);
});

it("fades every fine layer before it is a few pixels across", () => {
  const { fade } = settings.detail;
  const wavelength = settings.detail.rills.across;
  expect(detailFade(wavelength, wavelength / (fade.to + 1))).toBe(1);
  expect(detailFade(wavelength, wavelength / fade.from)).toBeCloseTo(0, 6);
  expect(detailFade(wavelength, wavelength / 1.5)).toBe(0);
  const between = detailFade(
    wavelength,
    wavelength / ((fade.from + fade.to) / 2)
  );
  expect(between).toBeGreaterThan(0);
  expect(between).toBeLessThan(1);
  // A flat field on screen draws none.
  expect(detailFade(wavelength, 0)).toBe(0);
});

it("lays soft strata at fixed elevations, gone where the beds crowd on screen", () => {
  const { strata } = settings;
  const [coarse = 1] = strata.spacing;
  const close = 1e-4;
  const tones: number[] = [];
  for (let elevation = 0.1; elevation < 0.6; elevation += 0.001) {
    const { tint, tone } = strataShade({ elevation, footprint: close });
    tones.push(tone);
    // Pastel and soft: within the contrast either way, a little rose at most.
    expect(Math.abs(tone - 1)).toBeLessThanOrEqual(strata.contrast + 1e-9);
    expect(tint).toBeGreaterThanOrEqual(0);
    expect(tint).toBeLessThanOrEqual(strata.tint.share);
  }
  expect(Math.max(...tones) - Math.min(...tones)).toBeGreaterThan(
    strata.contrast
  );
  // Fixed elevations: a bed repeats a coarse spacing up, whatever the ground.
  const at = (elevation: number) =>
    strataShade({ elevation, footprint: close }).tint;
  expect(at(0.2 + coarse)).toBeCloseTo(at(0.2), 6);
  // Beds narrower on screen than the fade are not drawn.
  expect(strataShade({ elevation: 0.2, footprint: coarse })).toEqual({
    tint: 0,
    tone: 1,
  });
});

it("gives a tread colour life: richer in hollows, paler on exposed ground, never dark", () => {
  const palette = landPalette(settings);
  const pigment = new Color("#cfe3c9");
  const paper = new Color(settings.pigment.paper);
  const tone = (curvature: number, gradient: [number, number] = [0, 0]) =>
    landTone(
      new Color(),
      pigment,
      {
        curvature,
        elevation: 0.4,
        gradient,
        sunBearing: [-Math.SQRT1_2, -Math.SQRT1_2],
      },
      palette
    );
  const distance = (colour: Color) =>
    Math.hypot(colour.r - paper.r, colour.g - paper.g, colour.b - paper.b);
  const luminance = (colour: Color) =>
    0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
  const open = tone(0);
  const hollow = tone(settings.life.hollow.curvature.to);
  const exposed = tone(-settings.life.exposed.curvature.to);
  // A hollow is further from the paper, more pigment, not merely darker.
  expect(distance(hollow)).toBeGreaterThan(distance(open));
  expect(luminance(hollow)).toBeGreaterThan(luminance(open) * 0.85);
  // Exposed ground goes back toward the paper.
  expect(distance(exposed)).toBeLessThan(distance(open));
  expect(luminance(exposed)).toBeGreaterThan(luminance(open));
  // Facing the sun warms a slope, turned from it cools.
  const toward = tone(0, [0.1, 0.1]);
  const away = tone(0, [-0.1, -0.1]);
  expect(toward.r - toward.b).toBeGreaterThan(open.r - open.b);
  expect(away.r - away.b).toBeLessThan(open.r - open.b);
  for (const colour of [open, hollow, exposed, toward, away]) {
    expect(luminance(colour)).toBeGreaterThan(0.35);
  }
});
