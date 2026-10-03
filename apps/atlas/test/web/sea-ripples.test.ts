import { describe, expect, it, vi } from "vitest";
import { penRuns, penWeights } from "../../src/web/scene/paint-paper";
import {
  paintSeaRipples,
  type SeaRipple,
} from "../../src/web/scene/sea-ripples";

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
  it("stays hidden at overview and draws only ripples in view", () => {
    const ctx = {
      beginPath: vi.fn(),
      globalAlpha: 1,
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
    };
    const ripple = (x: number): SeaRipple => ({
      box: [x - 60, -60, x + 60, 60],
      buckets: runs(0.28),
      level: 0,
    });
    const view = { height: 200, pixelsPerUnit: 0.8, width: 200, x: 0, y: 0 };
    const pen = ctx as unknown as CanvasRenderingContext2D;
    paintSeaRipples(pen, [ripple(0)], view);
    expect(ctx.stroke).not.toHaveBeenCalled();
    paintSeaRipples(pen, [ripple(0), ripple(1000)], {
      ...view,
      pixelsPerUnit: 4,
    });
    expect(ctx.stroke).toHaveBeenCalledTimes(penWeights.length);
    expect(ctx.globalAlpha).toBeLessThan(0.2);
  });
});
