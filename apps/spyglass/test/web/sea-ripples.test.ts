import { describe, expect, it } from "vitest";
import { inkAlpha, inks } from "../../src/web/ladder/ink-ladder";
import { alphaAt } from "../../src/web/layout/marks";
import { penRuns, penWeights } from "../../src/web/layout/pen-runs";
import { seaRippleMarks } from "../../src/web/layout/ripple-marks";
import type { SeaRipple } from "../../src/web/layout/sea-ripples";

const circle = Array.from({ length: 121 }, (_, index): [number, number] => [
  60 * Math.cos((index / 120) * Math.PI * 2),
  60 * Math.sin((index / 120) * Math.PI * 2),
]);

function runs(lift: number) {
  const buckets: number[][][] = penWeights.map(() => []);
  penRuns(circle, "ripple:test", buckets, lift);
  return buckets;
}

describe("gilded sea ripples", () => {
  it("lifts the pen where pressure is low, so ripples are broken lines", () => {
    const solid = runs(0).flat();
    const broken = runs(0.28).flat();
    const length = (all: number[][]) =>
      all.reduce((sum, run) => sum + run.length / 2 - 1, 0);
    expect(length(broken)).toBeLessThan(length(solid));
    expect(broken.length).toBeGreaterThan(1);
    expect(runs(0.28)).toEqual(runs(0.28));
  });
  it("marks every run flat on the sea, hidden at overview and surfacing with zoom", () => {
    const ripple = (level: number): SeaRipple => ({
      box: [-60, -60, 60, 60],
      buckets: runs(0.28),
      level,
    });
    const marks = seaRippleMarks([ripple(0), ripple(2)]);
    expect(marks).toHaveLength(runs(0.28).flat().length * 2);
    expect(new Set(marks.map((mark) => mark.colour))).toEqual(
      new Set([inks.ripple])
    );
    expect(marks.every((mark) => mark.on === undefined)).toBe(true);
    expect(new Set(marks.map((mark) => mark.width)).size).toBe(
      penWeights.length
    );
    const [first] = marks;
    const last = marks.at(-1);
    expect(alphaAt(first?.alpha ?? 0, 0.8)).toBe(0);
    expect(alphaAt(first?.alpha ?? 0, 4)).toBeCloseTo(inkAlpha.ripple[0]);
    expect(alphaAt(last?.alpha ?? 0, 4)).toBeCloseTo(inkAlpha.ripple[2]);
    // One alpha per level, shared, so the renderer keeps one batch per level.
    expect(
      new Set(marks.filter((mark) => mark.points).map((mark) => mark.alpha))
        .size
    ).toBe(2);
  });
});
