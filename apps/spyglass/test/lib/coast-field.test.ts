import { expect, it } from "vitest";
import { coastField } from "../../src/lib/visualization/coast-field";
import type { IslandGeometry } from "../../src/lib/visualization/types";

const island: IslandGeometry = {
  coast: [
    [
      [
        [-80, -10],
        [80, -10],
        [80, 10],
        [-80, 10],
        [-80, -10],
      ],
    ],
  ],
  hills: [],
  id: "long-coast",
  radius: 40,
  shallows: [],
  x: 300,
  y: -200,
};

it("follows an elongated real coastline instead of an island-center circle", () => {
  const field = coastField(island);
  expect(field).toBeDefined();
  expect(field?.distance(370, -200)).toBeCloseTo(0);
  expect(field?.distance(300, -130)).toBeGreaterThan(55);
  // Raster samples are 1.875 map units apart on this fixture.
  for (const [x, y] of [
    [390, -200],
    [300, -180],
  ] as const) {
    expect(
      Math.abs((field?.distance(x, y) ?? Number.POSITIVE_INFINITY) - 10)
    ).toBeLessThan(1.875);
  }
});

it("moves with its island and handles absent coast geometry", () => {
  const original = coastField(island);
  const moved = coastField({ ...island, x: island.x + 60, y: island.y + 80 });
  expect(moved?.distance(450, -120)).toBe(original?.distance(390, -200));
  expect(coastField({ ...island, coast: [] })).toBeUndefined();
});
