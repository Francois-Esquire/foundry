import { describe, expect, it, vi } from "vitest";

import { waveArrivalField } from "../../src/web/wave-field";

describe("wave arrival", () => {
  it("retains the precision used to compare queued arrival times", () => {
    const { arrival } = waveArrivalField(
      new Float32Array([100, 100]),
      2,
      1,
      1,
      90
    );
    expect(arrival[1]).toBeCloseTo(1 / 28, 14);
  });
  it("bounds queue work across a coastal depth field", () => {
    const width = 256;
    const depth = Float32Array.from({ length: width * width }, (_, i) =>
      Math.max(0, Math.hypot((i % width) - 64, Math.floor(i / width) - 64) - 24)
    );
    const { hypot } = Math;
    let visits = 0;
    const probe = vi.spyOn(Math, "hypot").mockImplementation((...values) => {
      visits += 1;
      if (visits > depth.length * 64) {
        throw new Error("Wave propagation repeatedly revisited cells");
      }
      return hypot(...values);
    });
    try {
      const { arrival } = waveArrivalField(depth, width, width, 1, 45);
      expect(
        [...arrival].every((time, i) => depth[i] === 0 || Number.isFinite(time))
      ).toBe(true);
    } finally {
      probe.mockRestore();
    }
  });
  it("propagates toward the selected bearing and reverses with wind", () => {
    const depth = new Float32Array(21 * 21).fill(100);
    const east = waveArrivalField(depth, 21, 21, 1, 90).arrival;
    const west = waveArrivalField(depth, 21, 21, 1, 270).arrival;
    expect(east[10 * 21 + 3]).toBeLessThan(east[10 * 21 + 17] ?? 0);
    expect(west[10 * 21 + 3]).toBeGreaterThan(west[10 * 21 + 17] ?? 0);
  });
  it("slows in shallow water and shelters the lee of land", () => {
    const deep = new Float32Array(21 * 21).fill(100);
    const shallow = new Float32Array(21 * 21).fill(4);
    expect(
      waveArrivalField(shallow, 21, 21, 1, 90).arrival[220]
    ).toBeGreaterThan(waveArrivalField(deep, 21, 21, 1, 90).arrival[220] ?? 0);
    for (let y = 6; y <= 14; y += 1) {
      deep[y * 21 + 10] = 0;
    }
    const field = waveArrivalField(deep, 21, 21, 1, 90);
    expect(field.arrival[10 * 21 + 10]).toBe(Number.POSITIVE_INFINITY);
    expect(field.exposure[10 * 21 + 13]).toBeLessThan(
      field.exposure[10 * 21 + 4] ?? 0
    );
    expect(Number.isFinite(field.arrival[10 * 21 + 13])).toBe(true);
  });
});
