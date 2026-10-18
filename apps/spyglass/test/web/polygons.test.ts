import { expect, it } from "vitest";
import type { Polygon, Territory } from "../../src/web/data/types";
import { insidePolygons, islandAt } from "../../src/web/polygons";

const square: Polygon = [
  [
    [-10, -10],
    [10, -10],
    [10, 10],
    [-10, 10],
    [-10, -10],
  ],
];
const territory: Territory = {
  analyzed: true,
  coast: [square],
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "island",
  radius: 20,
  responsibilityGroups: undefined,
  shallows: [square],
  x: 100,
  y: 100,
};

it("follows real polygons, including holes and detached islands", () => {
  const hole: Polygon = [
    ...square,
    [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
      [-2, -2],
    ],
  ];
  expect(insidePolygons({ x: 0, y: 0 }, [hole])).toBe(false);
  expect(insidePolygons({ x: 5, y: 0 }, [hole])).toBe(true);
  expect(islandAt({ x: 100, y: 100 }, [territory])?.id).toBe("island");
  expect(islandAt({ x: 0, y: 0 }, [territory])).toBeUndefined();
});
