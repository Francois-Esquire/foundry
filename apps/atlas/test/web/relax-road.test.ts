import { expect, it } from "vitest";

import { relaxRoad } from "../../src/web/relax-road";

it("relaxes grid bends without moving shared endpoints or inventing noise", () => {
  const original = Array.from({ length: 13 }, (_, i) => ({
    x: Math.min(i, 6) * 12,
    y: Math.max(0, i - 6) * 12,
  }));
  const saved = structuredClone(original);
  const result = relaxRoad(
    original,
    () => true,
    () => 0
  );
  expect(result[0]).toEqual(original[0]);
  expect(result.at(-1)).toEqual(original.at(-1));
  expect(original).toEqual(saved);
  expect(result).toEqual(
    relaxRoad(
      original,
      () => true,
      () => 0
    )
  );
  expect(result.some((p) => p.x > 15 && p.x < 60 && p.y > 5)).toBe(true);
});

it("retains land constraints during relaxation and curve subdivision", () => {
  const original = [
    { x: 0, y: 0 },
    { x: 0, y: 40 },
    { x: 40, y: 40 },
    { x: 40, y: 0 },
  ];
  const clear = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    for (let n = 0; n <= 100; n++) {
      const x = a.x + ((b.x - a.x) * n) / 100,
        y = a.y + ((b.y - a.y) * n) / 100;
      if (x > 8 && x < 32 && y < 32) {
        return false;
      }
    }
    return true;
  };
  const result = relaxRoad(original, clear, () => 0);
  expect(result.every((p, i) => !i || clear(result[i - 1] ?? p, p))).toBe(true);
});
