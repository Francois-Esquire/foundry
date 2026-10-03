import { describe, expect, it } from "vitest";

import {
  detailLevel,
  detailVisibility,
} from "../../src/web/scene/detail-level";

describe("atlas detail hierarchy", () => {
  it("keeps interaction detail stable through small zoom reversals", () => {
    let state = { composition: false, files: false };
    state = detailVisibility(state, 4.3, true);
    expect(state.files).toBe(true);
    state = detailVisibility(state, 4, true);
    expect(state.files).toBe(true);
    state = detailVisibility(state, 3.5, true);
    expect(state.files).toBe(false);
    state = detailVisibility(state, 7.1, true);
    expect(state.composition).toBe(true);
    state = detailVisibility(state, 6.8, true);
    expect(state.composition).toBe(true);
    expect(detailVisibility(state, 6.1, true).composition).toBe(false);
    expect(detailVisibility(state, 8, false).composition).toBe(false);
  });
  it("keeps overview specks, favors regions, then restores full files", () => {
    expect(detailLevel(0.8, true)).toEqual({
      composition: 0,
      districts: 0,
      files: 0,
      specks: 1,
    });
    expect(detailLevel(2, true)).toEqual({
      composition: 0,
      districts: 1,
      files: 0,
      specks: 0.85,
    });
    expect(detailLevel(5, true)).toEqual({
      composition: 0,
      districts: 0,
      files: 1,
      specks: 0,
    });
    expect(detailLevel(8, true)).toEqual({
      composition: 1,
      districts: 0,
      files: 1,
      specks: 0,
    });
  });
  it("crossfades regions and files without losing file marks", () => {
    for (let pixels = 0; pixels <= 12; pixels += 0.1) {
      const level = detailLevel(pixels, true);
      expect(level.districts + level.files).toBeLessThanOrEqual(1.000_001);
      expect(
        Object.values(level).every((value) => value >= 0 && value <= 1)
      ).toBe(true);
    }
    expect(detailLevel(12)).toEqual({
      composition: 0,
      districts: 0,
      files: 1,
      specks: 0,
    });
  });
});
