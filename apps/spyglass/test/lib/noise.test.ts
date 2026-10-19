import { expect, it } from "vitest";
import {
  domainWarp,
  fbm,
  gradientNoise,
  latticeHash,
  noiseSeed,
  ridgedFbm,
  valueNoise,
} from "../../src/lib/visualization/noise";

const seed = noiseSeed("noise-test");
const other = noiseSeed("noise-test:other");

/** Sample points spread over positive and negative coordinates, off the lattice. */
const points = Array.from({ length: 2000 }, (_, i): [number, number] => [
  ((i * 0.618_034) % 1) * 200 - 100,
  ((i * 0.414_214) % 1) * 200 - 100 + i * 0.013,
]);

const signed = [
  ["value", valueNoise],
  ["gradient", gradientNoise],
  ["fbm", (x: number, y: number, s: number) => fbm(x, y, s)],
] as const;

it("seeds from strings deterministically, as unsigned 32-bit integers", () => {
  expect(noiseSeed("noise-test")).toBe(seed);
  expect(seed).not.toBe(other);
  expect(Number.isInteger(seed)).toBe(true);
  expect(seed).toBeGreaterThanOrEqual(0);
  expect(seed).toBeLessThan(2 ** 32);
  expect(latticeHash(-3, 7, seed)).toBe(latticeHash(-3, 7, seed));
  expect(latticeHash(-3, 7, seed)).not.toBe(latticeHash(3, 7, seed));
});

it("keeps signed noise in [-1, 1] and ridged noise in [0, 1]", () => {
  for (const [name, noise] of signed) {
    let low = 1;
    let high = -1;
    for (const [x, y] of points) {
      const value = noise(x, y, seed);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    expect(low, name).toBeGreaterThanOrEqual(-1);
    expect(high, name).toBeLessThanOrEqual(1);
    // The noise spans a real range, not a constant.
    expect(high - low, name).toBeGreaterThan(0.5);
  }
  for (const [x, y] of points) {
    const value = ridgedFbm(x, y, seed);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  }
});

it("is deterministic for a fixed seed and differs between seeds", () => {
  for (const [name, noise] of signed) {
    const first = points.map(([x, y]) => noise(x, y, seed));
    expect(
      points.map(([x, y]) => noise(x, y, seed)),
      name
    ).toEqual(first);
    const changed = points.filter(
      ([x, y], i) => noise(x, y, other) !== first[i]
    ).length;
    expect(changed, name).toBeGreaterThan(points.length * 0.9);
  }
  const ridged = points.map(([x, y]) => ridgedFbm(x, y, seed));
  expect(points.map(([x, y]) => ridgedFbm(x, y, seed))).toEqual(ridged);
  expect(points.map(([x, y]) => ridgedFbm(x, y, other))).not.toEqual(ridged);
});

it("is continuous: a small step changes the value a little", () => {
  for (const [x, y] of points.slice(0, 200)) {
    expect(
      Math.abs(gradientNoise(x + 1e-4, y, seed) - gradientNoise(x, y, seed))
    ).toBeLessThan(1e-3);
    expect(Math.abs(fbm(x, y + 1e-4, seed) - fbm(x, y, seed))).toBeLessThan(
      1e-2
    );
  }
});

it("is zero at every lattice point as gradient noise", () => {
  for (let x = -5; x <= 5; x += 1) {
    expect(gradientNoise(x, 3, seed)).toBeCloseTo(0, 12);
  }
});

it("warps a point by at most its amplitude in each axis, deterministically", () => {
  const settings = {
    amplitude: 12,
    frequency: 1 / 40,
    gain: 0.5,
    lacunarity: 2,
    octaves: 3,
  };
  let moved = 0;
  for (const [x, y] of points) {
    const [wx, wy] = domainWarp(x, y, seed, settings);
    expect(Math.abs(wx - x)).toBeLessThanOrEqual(settings.amplitude);
    expect(Math.abs(wy - y)).toBeLessThanOrEqual(settings.amplitude);
    expect(domainWarp(x, y, seed, settings)).toEqual([wx, wy]);
    moved = Math.max(moved, Math.hypot(wx - x, wy - y));
  }
  expect(moved).toBeGreaterThan(settings.amplitude * 0.3);
  const [dx, dy] = domainWarp(0.3, 0.7, seed);
  expect(Math.abs(dx - 0.3)).toBeLessThanOrEqual(1);
  expect(Math.abs(dy - 0.7)).toBeLessThanOrEqual(1);
});
