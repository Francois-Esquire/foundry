import { describe, expect, it } from "vitest";
import {
  bearingsOf,
  measureOf,
  withAdvance,
  withLeftBearing,
  withMeasure,
  withRightBearing,
} from "~/studio/bearings";
import { EMPTY_OUTLINE, outlineBounds } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";
import { TRIANGLE } from "../helpers/fixtures";

/** The triangle spans x 100 to 900, so its bearings are 100 and 100. */
const GLYPH: GlyphShape = { advance: 1000, outline: TRIANGLE };
const SPACE: GlyphShape = { advance: 250, outline: EMPTY_OUTLINE };

describe("bearings", () => {
  it("reads the gaps on each side of the outline", () => {
    expect(bearingsOf(GLYPH)).toEqual({ left: 100, right: 100 });
  });

  it("has none for a glyph with nothing drawn", () => {
    expect(bearingsOf(SPACE)).toBeUndefined();
    expect(measureOf(SPACE, "left")).toBeUndefined();
    expect(measureOf(SPACE, "advance")).toBe(250);
  });

  it("changes the advance and leaves the outline, so the right bearing follows", () => {
    const wider = withAdvance(GLYPH, 1080);
    expect(wider.outline).toBe(GLYPH.outline);
    expect(bearingsOf(wider)).toEqual({ left: 100, right: 180 });
  });

  it("never lets the advance go below zero and keeps whole units", () => {
    expect(withAdvance(GLYPH, -40).advance).toBe(0);
    expect(withAdvance(GLYPH, 512.6).advance).toBe(513);
  });

  it("sets the left bearing by moving the outline and the advance together", () => {
    const tighter = withLeftBearing(GLYPH, 60);
    expect(outlineBounds(tighter.outline)?.xMin).toBe(60);
    expect(tighter.advance).toBe(960);
    expect(bearingsOf(tighter)).toEqual({ left: 60, right: 100 });
  });

  it("allows a negative left bearing", () => {
    expect(bearingsOf(withLeftBearing(GLYPH, -20))).toEqual({
      left: -20,
      right: 100,
    });
  });

  it("returns the same shape when the left bearing does not change", () => {
    expect(withLeftBearing(GLYPH, 100)).toBe(GLYPH);
  });

  it("sets the right bearing by moving the advance alone", () => {
    const looser = withRightBearing(GLYPH, 140);
    expect(looser.outline).toBe(GLYPH.outline);
    expect(looser.advance).toBe(1040);
  });

  it("leaves a glyph with nothing drawn alone when a bearing is set", () => {
    expect(withLeftBearing(SPACE, 40)).toBe(SPACE);
    expect(withRightBearing(SPACE, 40)).toBe(SPACE);
  });

  it("sets whichever measure is named", () => {
    expect(withMeasure(GLYPH, "advance", 900).advance).toBe(900);
    expect(measureOf(withMeasure(GLYPH, "left", 10), "left")).toBe(10);
    expect(measureOf(withMeasure(GLYPH, "right", 10), "right")).toBe(10);
  });
});
