import { expect, it } from "vitest";
import type { Polygon } from "../../src/web/data/types";
import {
  boatRadius,
  createSailing,
  sailingSpeed,
} from "../../src/web/layout/sailing";
import { chartFixture } from "../helpers/chart-fixture";
import { loadSpyglass } from "../helpers/reference-spyglass";

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

it("normalizes diagonal movement and clamps elapsed time without mutating the pose", () => {
  const sea = createSailing({ territories: [] }, { height: 200, width: 200 });
  const pose = { heading: 0, x: 0, y: 0 };
  const east = sea.advance(pose, { x: 1, y: 0 }, 0.025);
  const diagonal = sea.advance(pose, { x: 1, y: 1 }, 0.025);
  expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(east.x);
  expect(east.x).toBe(sailingSpeed * 0.025);
  expect(diagonal.heading).toBeCloseTo(Math.PI / 4);
  expect(sea.advance(pose, { x: 1, y: 0 }, 30).x).toBe(sailingSpeed * 0.05);
  expect(sea.advance(pose, { x: 0, y: 0 }, 1)).toBe(pose);
  expect(sea.advance(pose, { x: 1, y: 0 }, -1)).toBe(pose);
  expect(sea.advance(pose, { x: 1, y: 0 }, Number.NaN)).toBe(pose);
  expect(pose).toEqual({ heading: 0, x: 0, y: 0 });
});

it("stops the whole hull before coastlines and world boundaries even after a long frame", () => {
  const sea = createSailing({ territories: [] }, { height: 200, width: 200 }, [
    rectangle(0, -50, 0.02, 50),
  ]);
  const pose = { heading: 0, x: -boatRadius - 0.1, y: 0 };
  expect(sea.canSail(pose)).toBe(true);
  expect(sea.advance(pose, { x: 1, y: 0 }, 60)).toBe(pose);
  const edge = { heading: 0, x: 100 - boatRadius - 0.1, y: 80 };
  expect(sea.advance(edge, { x: 1, y: 0 }, 1)).toBe(edge);
  expect(sea.advance(pose, { x: -1, y: 0 }, 0.05).x).toBeLessThan(pose.x);
});

it("tests the swept hull, including collisions between two otherwise safe positions", () => {
  const tip: Polygon = [
    [
      [0, 0],
      [0.1, 1],
      [-0.1, 1],
      [0, 0],
    ],
  ];
  const sea = createSailing({ territories: [] }, { height: 200, width: 200 }, [
    tip,
  ]);
  const pose = { heading: 0, x: -0.6, y: -5.98 };
  expect(sea.canSail(pose)).toBe(true);
  expect(sea.canSail({ x: 0.6, y: -5.98 })).toBe(true);
  expect(sea.advance(pose, { x: 1, y: 0 }, 0.05)).toBe(pose);
});

it("uses translated island coasts, holes, and connecting land regardless of display layers", () => {
  const data = chartFixture();
  const [island] = data.territories;
  if (!island) {
    throw new Error("Study island is required.");
  }
  island.x = 100;
  island.coast = [
    [...rectangle(-40, -40, 40, 40), ...rectangle(-15, -15, 15, 15)],
  ];
  const sea = createSailing(data, { height: 200, width: 400 }, [
    rectangle(-30, -20, 30, 20),
  ]);
  expect(sea.canSail({ x: 100, y: 0 })).toBe(true);
  expect(sea.canSail({ x: 110, y: 0 })).toBe(false);
  expect(sea.canSail({ x: 125, y: 0 })).toBe(false);
  expect(sea.canSail({ x: 0, y: 0 })).toBe(false);
  expect(sea.canSail({ x: 0, y: 40 })).toBe(true);
});

it("finds deterministic open water in dense maps and reports maps with no available water", async () => {
  const data = await loadSpyglass();
  const sea = createSailing(data, {
    height: data.height * 2,
    width: data.width * 2,
  });
  const spawn = sea.spawn({ x: 0, y: 0 });
  expect(spawn).not.toBeNull();
  expect(spawn && sea.canSail(spawn)).toBe(true);
  expect(sea.spawn({ x: 0, y: 0 })).toEqual(spawn);
  const packed = createSailing(
    { territories: [] },
    { height: 200, width: 200 },
    [rectangle(-80, -80, 80, 80)]
  );
  const margin = packed.spawn({ x: 0, y: 0 });
  expect(margin && packed.canSail(margin)).toBe(true);
  const covered = createSailing(
    { territories: [] },
    { height: 200, width: 200 },
    [rectangle(-100, -100, 100, 100)]
  );
  expect(covered.spawn({ x: 0, y: 0 })).toBeNull();
  expect(
    createSailing({ territories: [] }, { height: 4, width: 4 }).spawn({
      x: 0,
      y: 0,
    })
  ).toBeNull();
});

it("finds a valid small lagoon between radial spawn samples", () => {
  const land = [
    ...rectangle(-100, -100, 100, 100),
    ...rectangle(13, 13, 27, 27),
  ];
  const sea = createSailing({ territories: [] }, { height: 200, width: 200 }, [
    land,
  ]);
  expect(sea.canSail({ x: 20, y: 20 })).toBe(true);
  const pose = sea.spawn({ x: 0, y: 0 });
  expect(pose).not.toBeNull();
  expect(pose && sea.canSail(pose)).toBe(true);
});
