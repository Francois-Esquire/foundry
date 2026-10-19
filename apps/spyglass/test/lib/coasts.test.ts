import { expect, it } from "vitest";
import {
  coastMask,
  defaultCoastSettings,
  maskDistance,
  pieceDepths,
  previewCoasts,
} from "../../src/lib/visualization/coasts";
import { shoreDistances } from "../../src/lib/visualization/distance-field";
import {
  type GeologyGrid,
  sampleGrid,
} from "../../src/lib/visualization/geology";
import type { TerrainIsland } from "../../src/lib/visualization/terrain";
import { chartWorld } from "../../src/web/layout/chart-world";
import { loadSpyglass } from "../helpers/reference-spyglass";

function circle(
  radius: number,
  cx = 0,
  cy = 0,
  clockwise = false
): [number, number][] {
  const ring: [number, number][] = Array.from({ length: 64 }, (_, i) => [
    cx + Math.cos((i * Math.PI) / 32) * radius,
    cy + Math.sin((i * Math.PI) / 32) * radius,
  ]);
  return clockwise ? ring.reverse() : ring;
}

function island(
  id: string,
  coast: TerrainIsland["coast"],
  x = 0,
  y = 0
): TerrainIsland {
  return { coast, id, radius: 80, x, y };
}

/** A fine grid over the given half extent, one map unit a cell. */
function fineGrid(half: number): GeologyGrid {
  return {
    cell: 1,
    height: 2 * half,
    left: -half,
    top: -half,
    width: 2 * half,
  };
}

/** Whether the map position falls on land of the mask. */
function landAt(grid: GeologyGrid, mask: Uint8Array, x: number, y: number) {
  const column = Math.floor((x - grid.left) / grid.cell);
  const row = Math.floor((y - grid.top) / grid.cell);
  return mask[row * grid.width + column] === 1;
}

/** Connected pieces of land, 8-connected, as cell counts. */
function pieceAreas(mask: Uint8Array, width: number, height: number) {
  const seen = new Uint8Array(mask.length);
  const areas: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) {
      continue;
    }
    let area = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const at = stack.pop() as number;
      area += 1;
      const column = at % width;
      const row = (at - column) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const c = column + dx;
          const r = row + dy;
          const next = r * width + c;
          if (
            c >= 0 &&
            r >= 0 &&
            c < width &&
            r < height &&
            mask[next] &&
            !seen[next]
          ) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    areas.push(area);
  }
  return areas;
}

it("fills a small pool in the land but keeps a large enclosed water", () => {
  const pool = island("pool", [
    [circle(60), circle(5, -25, 0, true), circle(22, 25, 0, true)],
  ]);
  const [preview] = previewCoasts([pool]);
  const grid = fineGrid(90);
  const mask = coastMask(grid, [preview as TerrainIsland]);
  // The small pool, 79 square map units, is land now.
  expect(landAt(grid, mask, -25, 0)).toBe(true);
  // The large one, about 1,500, is still water.
  expect(landAt(grid, mask, 25, 0)).toBe(false);
});

it("joins a near islet by a sandbar and keeps a far one as a cay no smaller than its radius", () => {
  const { radius } = defaultCoastSettings.islets;
  const near = island("near", [[circle(50)], [circle(4, 64, 0)]]);
  const far = island("far", [[circle(50)], [circle(4, 0, 90)]]);
  const grid = fineGrid(120);
  const [nearCoast] = previewCoasts([near]);
  const nearMask = coastMask(grid, [nearCoast as TerrainIsland]);
  expect(pieceAreas(nearMask, grid.width, grid.height)).toHaveLength(1);
  // The bar runs along the gap between them.
  expect(landAt(grid, nearMask, 57, 0)).toBe(true);
  const [farCoast] = previewCoasts([far]);
  const farMask = coastMask(grid, [farCoast as TerrainIsland]);
  const areas = pieceAreas(farMask, grid.width, grid.height).sort(
    (a, b) => a - b
  );
  expect(areas).toHaveLength(2);
  // The cay is grown to at least its radius, less a cell for the tracing.
  expect(areas[0]).toBeGreaterThanOrEqual(Math.PI * (radius - 1) ** 2);
  for (const [dx, dy] of [
    [radius - 1, 0],
    [-(radius - 1), 0],
    [0, radius - 1],
    [0, -(radius - 1)],
  ] as const) {
    expect(landAt(grid, farMask, dx, 90 + dy)).toBe(true);
  }
});

it("moves a coast out by at most `outward` and in by at most `inward`", () => {
  const { inward, outward } = defaultCoastSettings.sculpt;
  const blob = island("blob", [[circle(70)]], 13, -7);
  const [preview] = previewCoasts([blob]);
  const grid = fineGrid(110);
  const surveyed = coastMask(grid, [blob]);
  const sculpted = coastMask(grid, [preview as TerrainIsland]);
  const distance = maskDistance(surveyed, grid.width, grid.height, grid.cell);
  let movedOut = 0;
  let movedIn = 0;
  let changed = 0;
  for (const [at, value] of distance.entries()) {
    if (sculpted[at] && value > 0) {
      movedOut = Math.max(movedOut, value);
    }
    if (!sculpted[at] && value < 0) {
      movedIn = Math.max(movedIn, -value);
    }
    changed += Number(sculpted[at] !== surveyed[at]);
  }
  // The sculpture shows, within its bounds and a cell for the tracing.
  expect(changed).toBeGreaterThan(200);
  expect(movedOut).toBeGreaterThan(outward / 2);
  expect(movedOut).toBeLessThanOrEqual(outward + 1);
  expect(movedIn).toBeGreaterThan(inward / 2);
  expect(movedIn).toBeLessThanOrEqual(inward + 1);
});

it("never grows two islands into one", () => {
  const { clearance } = defaultCoastSettings;
  const a = island("a", [[circle(40)]], -45, 0);
  const b = island("b", [[circle(40)]], 45, 0);
  const grid = fineGrid(110);
  const coasts = previewCoasts([a, b]);
  const both = coastMask(grid, coasts);
  expect(pieceAreas(both, grid.width, grid.height)).toHaveLength(2);
  // Neither grows nearer the other's surveyed coast than the clearance.
  const theirs = coastMask(grid, [b]);
  const mine = coastMask(grid, [coasts[0] as TerrainIsland]);
  const toB = shoreDistances(theirs, grid.width, grid.height);
  const surveyedA = coastMask(grid, [a]);
  for (const [at, land] of mine.entries()) {
    if (land && !surveyedA[at]) {
      expect((toB[at] ?? 0) * grid.cell).toBeGreaterThanOrEqual(clearance - 1);
    }
  }
});

it("is deterministic and keeps each island's id, place and radius", () => {
  const islands = [
    island("a", [[circle(40)], [circle(5, 60, 10)]], -45, 0),
    island("b", [[circle(30)]], 70, 40),
  ];
  const first = previewCoasts(islands);
  const second = previewCoasts(islands);
  expect(second).toEqual(first);
  expect(first.map(({ id, radius, x, y }) => [id, radius, x, y])).toEqual(
    islands.map(({ id, radius, x, y }) => [id, radius, x, y])
  );
  expect(first.map(({ coast }) => coast)).not.toEqual(
    islands.map(({ coast }) => coast)
  );
});

it("measures piece depth per piece of land", () => {
  const grid = fineGrid(60);
  const mask = coastMask(grid, [
    island("two", [[circle(20, -30, 0)], [circle(6, 30, 0)]]),
  ]);
  const distance = maskDistance(mask, grid.width, grid.height, grid.cell);
  const depths = pieceDepths(grid, distance);
  const at = (x: number, y: number) =>
    depths[(y - grid.top) * grid.width + (x - grid.left)] ?? 0;
  expect(at(-30, 0)).toBeGreaterThan(18);
  expect(at(-30, 0)).toBeLessThan(20);
  expect(at(-45, 0)).toBe(at(-30, 0));
  expect(at(30, 0)).toBeLessThan(7);
  expect(at(0, 0)).toBe(0);
});

it("cleans the reference chart's coasts: its pools filled, its islets grown, every file on land", async () => {
  const data = await loadSpyglass();
  const { world } = chartWorld(data);
  const sea = (x: number, y: number) => world.sample(x, y) < 0;
  const land = Uint8Array.from(world.signedDistance, (d) => (d < 0 ? 1 : 0));
  // No enclosed water smaller than the hole area remains inside a coast.
  const open = new Uint8Array(land.length);
  const stack: number[] = [];
  for (let at = 0; at < land.length; at += 1) {
    const column = at % world.width;
    const row = (at - column) / world.width;
    const edge =
      column === 0 ||
      row === 0 ||
      column === world.width - 1 ||
      row === world.height - 1;
    if (edge && !land[at]) {
      open[at] = 1;
      stack.push(at);
    }
  }
  while (stack.length) {
    const at = stack.pop() as number;
    for (const next of [at - 1, at + 1, at - world.width, at + world.width]) {
      if (next >= 0 && next < land.length && !land[next] && !open[next]) {
        open[next] = 1;
        stack.push(next);
      }
    }
  }
  const pockets = [...land.keys()].filter((at) => !(land[at] || open[at]));
  expect(pockets).toEqual([]);
  // The two pools the surveyed coasts held are land.
  const territory = (id: string) =>
    data.territories.find((each) => each.id === id) ?? { x: 0, y: 0 };
  const marbles = territory("@foundry.sh/marbles");
  const spyglass = territory("@foundry/spyglass");
  expect(
    world.signedDistance[
      Math.floor((spyglass.y - 8 - world.top) / world.cell) * world.width +
        Math.floor((spyglass.x - 35 - world.left) / world.cell)
    ]
  ).toBeLessThan(0);
  expect(sea(spyglass.x - 35, spyglass.y - 8)).toBe(false);
  expect(
    world.signedDistance[
      Math.floor((marbles.y + 8 - world.top) / world.cell) * world.width +
        Math.floor((marbles.x - 21 - world.left) / world.cell)
    ]
  ).toBeLessThan(0);
  // Every piece of land is at least a grown cay.
  const { radius } = defaultCoastSettings.islets;
  const smallest = Math.min(...pieceAreas(land, world.width, world.height));
  expect(smallest * world.cell ** 2).toBeGreaterThanOrEqual(
    0.6 * Math.PI * radius ** 2
  );
  // Every island keeps land of its own, and each piece of land one owner.
  expect(new Set(world.owner.filter((owner) => owner >= 0)).size).toBe(
    data.territories.length
  );
  // No file is drowned by the coast's movement: each stands inside a coast.
  const drowned: string[] = [];
  for (const each of data.territories) {
    for (const file of each.files) {
      const x = each.x + file.x;
      const y = each.y + file.y;
      if (sampleGrid(world, world.signedDistance, x, y) >= 0) {
        drowned.push(file.id);
      }
    }
  }
  expect(drowned).toEqual([]);
});
