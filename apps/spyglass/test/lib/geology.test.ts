import { expect, it } from "vitest";
import {
  depthBand,
  depthBands,
  elevationAtDepth,
  elevationAtHeight,
  geologyLevels,
  gradientGrid,
  nominalDepth,
  nominalHeight,
  rampLandform,
  sampleGrid,
} from "../../src/lib/visualization/geology";

it("reads the structural bands as the chart's nominal depths", () => {
  expect(nominalDepth(0)).toBe(0);
  expect(nominalDepth(0.5)).toBe(0);
  expect(nominalDepth(geologyLevels.shelfTop)).toBeCloseTo(50);
  expect(nominalDepth(geologyLevels.basementTop)).toBeCloseTo(1000);
  expect(nominalDepth(geologyLevels.abyss)).toBeCloseTo(3000);
  expect(nominalDepth(geologyLevels.trenchFloor)).toBeCloseTo(6000);
  expect(nominalDepth(-2)).toBe(6000);
});

it("inverts nominal depth and keeps it monotonic", () => {
  let previous = -1;
  for (let elevation = 0; elevation >= -1.25; elevation -= 0.01) {
    const depth = nominalDepth(elevation);
    expect(depth).toBeGreaterThan(previous);
    expect(elevationAtDepth(depth)).toBeCloseTo(elevation, 6);
    previous = depth;
  }
});

it("names a depth by its band and reads land heights", () => {
  expect(depthBands.map(({ id }) => id)).toEqual([
    "shoreline",
    "shallows",
    "shelf",
    "slope",
    "deep",
    "trench",
  ]);
  expect(depthBand(0)).toBe("shoreline");
  expect(depthBand(20)).toBe("shallows");
  expect(depthBand(120)).toBe("shelf");
  expect(depthBand(500)).toBe("slope");
  expect(depthBand(2000)).toBe("deep");
  expect(depthBand(4000)).toBe("trench");
  expect(nominalHeight(-0.5)).toBe(0);
  expect(nominalHeight(1)).toBeGreaterThan(nominalHeight(0.5));
});

it("samples a grid bilinearly between cell centres and clamps at its edge", () => {
  const grid = { cell: 10, height: 2, left: 0, top: 0, width: 2 };
  const values = [0, 10, 20, 30];
  expect(sampleGrid(grid, values, 5, 5)).toBe(0);
  expect(sampleGrid(grid, values, 15, 15)).toBe(30);
  expect(sampleGrid(grid, values, 10, 5)).toBe(5);
  expect(sampleGrid(grid, values, 10, 10)).toBe(15);
  expect(sampleGrid(grid, values, -100, -100)).toBe(0);
  const [dx, dy] = gradientGrid(
    { cell: 1, height: 3, left: 0, top: 0, width: 3 },
    [0, 1, 2, 0, 1, 2, 0, 1, 2],
    1.5,
    1.5
  );
  expect(dx).toBeCloseTo(1);
  expect(dy).toBeCloseTo(0);
});

it("keeps the ramp landform's coast at the water and caps it at full land", () => {
  const land = rampLandform(40);
  const at = (inland: number) => land({ inland, islandId: "a", x: 0, y: 0 });
  expect(at(0)).toBe(0);
  expect(at(20)).toBeCloseTo(0.5);
  expect(at(400)).toBe(geologyLevels.land);
});

it("inverts nominal height and caps it at full land", () => {
  expect(elevationAtHeight(nominalHeight(0.4))).toBeCloseTo(0.4);
  expect(elevationAtHeight(-5)).toBe(0);
  expect(elevationAtHeight(1e6)).toBe(geologyLevels.land);
});
