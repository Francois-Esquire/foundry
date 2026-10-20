import { describe, expect, it } from "vitest";
import type { SpyglassData, Territory } from "../../src/web/data/types";
import { oceanField } from "../../src/web/layout/ocean-field";
import { singleFrame } from "../helpers/frames";

/** A square island of half-side 7 at the chart's centre. */
const island: Territory = {
  analyzed: true,
  coast: [
    [
      [
        [-7, -7],
        [7, -7],
        [7, 7],
        [-7, 7],
        [-7, -7],
      ],
    ],
  ],
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "a",
  label: "a",
  radius: 7,
  responsibilityGroups: undefined,
  shallows: [],
  x: 0,
  y: 0,
};
const data: SpyglassData = {
  coverage: "test",
  fileEdges: [],
  folderCells: {},
  frames: [singleFrame(["a"])],
  height: 400,
  packageLayers: {},
  routes: [],
  territories: [island],
  width: 400,
};

describe("ocean field", () => {
  // At 100 cells over 400 units each cell is 4 units; the island spans grid
  // 48.25 to 51.75 on both axes, between the sample offsets of cells 47 and
  // 52 on either side, so cells 48 to 51 are land.
  const field = oceanField(data, 100);
  const { width, height, land, distances, outside } = field;
  const at = (row: number, column: number) => row * width + column;

  it("rasterizes the coast onto the grid without a canvas", () => {
    expect([width, height, field.scale]).toEqual([100, 100, 0.25]);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const inside = row >= 48 && row <= 51 && column >= 48 && column <= 51;
        expect(land[at(row, column)]).toBe(inside ? 1 : 0);
      }
    }
  });

  it("measures shore distances in cells, rising one per cell away from a straight coast", () => {
    for (let column = 48; column <= 51; column += 1) {
      expect(distances[at(50, column)]).toBe(0);
    }
    for (let column = 52; column < width; column += 1) {
      expect(distances[at(50, column)]).toBe(column - 51);
    }
    for (let row = 47; row >= 0; row -= 1) {
      expect(distances[at(row, 50)]).toBe(48 - row);
    }
    // Off the corner the distance is Euclidean, not a Manhattan count.
    expect(distances[at(44, 55)]).toBeCloseTo(Math.hypot(4, 4), 5);
  });

  it("builds the open-sea field from a rim that contains every land cell", () => {
    expect(field.rims).toHaveLength(1);
    for (const [i, cell] of land.entries()) {
      if (cell) {
        expect(outside[i]).toBe(0);
      }
    }
    // The rim pads the island by 110 units, inside this 400-unit chart, so
    // the corners of the grid lie in open water.
    expect(outside[at(0, 0)]).toBeGreaterThan(0);
    expect(outside[at(height - 1, width - 1)]).toBeGreaterThan(0);
    // Open water begins at the rim: the distance grows toward the corner.
    for (let column = 98; column > 50; column -= 1) {
      expect(outside[at(50, column + 1)]).toBeGreaterThanOrEqual(
        outside[at(50, column)] ?? 0
      );
    }
  });
});
