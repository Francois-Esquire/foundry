import { expect, it } from "vitest";
import { createCoastSeparation } from "../../src/lib/visualization/coast-collision";
import type {
  IslandGeometry,
  Polygon,
} from "../../src/lib/visualization/types";

const rectangle = (
  left: number,
  top: number,
  right: number,
  bottom: number
): Polygon => [
  [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top],
  ],
];
const island = (id: string, coast: Polygon[]): IslandGeometry => ({
  coast,
  hills: [],
  id,
  radius: 200,
  shallows: [],
  x: 0,
  y: 0,
});

it("allows another island between separate land components without treating their ocean as land", () => {
  const a = island("a", [
    rectangle(-100, -10, -80, 10),
    rectangle(80, -10, 100, 10),
  ]);
  const b = island("b", [rectangle(-10, -10, 10, 10)]);
  expect(createCoastSeparation([a, b], 8)()).toBe(0);
  expect(a.x).toBe(0);
  expect(b.x).toBe(0);
});

it("separates a fully contained coastline, retaining the requested water gap", () => {
  const a = island("a", [rectangle(-100, -50, 100, 50)]);
  const b = island("b", [rectangle(-10, -10, 10, 10)]);
  const separate = createCoastSeparation([a, b], 8);
  expect(separate()).toBeGreaterThan(0);
  expect(Math.abs(a.y - b.y)).toBeCloseTo(68);
  expect(separate()).toBeLessThan(0.001);
});

it("uses slanted coastline edges when axis-aligned bounds overlap", () => {
  const a = island("a", [
    [
      [
        [-40, -10],
        [-10, -40],
        [40, 10],
        [10, 40],
        [-40, -10],
      ],
    ],
  ]);
  const b = structuredClone(a);
  b.id = "b";
  b.x = 50;
  b.y = -50;
  expect(createCoastSeparation([a, b], 8)()).toBe(0);
  expect(b.x).toBe(50);
});

it("allows elongated islands inside their old radius bubbles when land is separated", () => {
  const a = island("a", [rectangle(-180, -30, 180, 30)]);
  const b = island("b", [rectangle(-180, -30, 180, 30)]);
  b.y = 70;
  expect(createCoastSeparation([a, b], 8)()).toBe(0);
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(a.radius + b.radius);
});
