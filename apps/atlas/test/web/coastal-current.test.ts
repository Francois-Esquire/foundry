import { describe, expect, it } from "vitest";

import { coastalCurrent } from "../../src/web/scene/coastal-current";

describe("island-aware current", () => {
  it("splits upstream, passes both flanks, and rejoins downstream", () => {
    const width = 61;
    const land = Uint8Array.from({ length: width * width }, (_, i) =>
      Math.hypot((i % width) - 30, Math.floor(i / width) - 30) <= 9 ? 1 : 0
    );
    const vx = new Float32Array(land.length).fill(0.6);
    const vy = new Float32Array(land.length);
    const flow = coastalCurrent(vx, vy, land, width, width);
    expect(flow.x[30 * width + 18]).toBeLessThan(0.4);
    expect(flow.y[24 * width + 19]).toBeLessThan(-0.05);
    expect(flow.y[36 * width + 19]).toBeGreaterThan(0.05);
    expect(flow.x[18 * width + 30]).toBeGreaterThan(0.6);
    expect(flow.y[24 * width + 41]).toBeGreaterThan(0.05);
    expect(flow.y[36 * width + 41]).toBeLessThan(-0.05);
    for (let i = 0; i < land.length; i += 1) {
      if (land[i]) {
        expect(flow.x[i]).toBe(0);
        expect(flow.y[i]).toBe(0);
      }
      expect(Number.isFinite(flow.x[i])).toBe(true);
      expect(Number.isFinite(flow.y[i])).toBe(true);
    }
    expect(vx.every((value) => Math.abs(value - 0.6) < 0.000_01)).toBe(true);
    expect(vy.every((value) => value === 0)).toBe(true);
  });
  it("preserves uniform open water and does not invent motion in still water", () => {
    const vx = new Float32Array(100).fill(0.5),
      vy = new Float32Array(100);
    const land = new Uint8Array(100);
    expect(coastalCurrent(vx, vy, land, 10, 10)).toEqual({ x: vx, y: vy });
    land[55] = 1;
    const still = coastalCurrent(vy, vy, land, 10, 10);
    expect(still).toEqual({ x: vy, y: vy });
  });
});
