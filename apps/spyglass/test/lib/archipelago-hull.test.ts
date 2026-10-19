import { expect, it } from "vitest";
import {
  type ArchipelagoOutline,
  archipelagoOutline,
  defaultHullSettings,
  emanationField,
  type HullIsland,
  hullRings,
  ringCoordinate,
  ringOffset,
} from "../../src/lib/visualization/archipelago-hull";
import { sampleGrid } from "../../src/lib/visualization/geology";
import { terrainSilhouette } from "../../src/lib/visualization/terrain";
import type { SpyglassData } from "../../src/web/data/types";
import { chartTerrain } from "../../src/web/layout/chart-terrain";
import { chartSeaBounds } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

type Point = readonly [number, number];

function islandsOf(data: SpyglassData, group = ""): HullIsland[] {
  return data.territories.map((territory) => ({
    coast: territory.coast,
    group,
    id: territory.id,
    radius: territory.radius,
    x: territory.x,
    y: territory.y,
  }));
}

function coastPoints(island: HullIsland): Point[] {
  return island.coast.flatMap((polygon) =>
    (polygon[0] ?? []).map(
      ([x = 0, y = 0]): Point => [island.x + x, island.y + y]
    )
  );
}

function inside(ring: readonly Point[], [x, y]: Point): boolean {
  let within = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [ax, ay] = ring[i] ?? [0, 0];
    const [bx, by] = ring[j] ?? [0, 0];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
      within = !within;
    }
  }
  return within;
}

function distanceTo(ring: readonly Point[], [x, y]: Point): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [ax, ay] = ring[j] ?? [0, 0];
    const [bx, by] = ring[i] ?? [0, 0];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.min(
      1,
      Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))
    );
    nearest = Math.min(nearest, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return nearest;
}

/** The sum of the absolute turning angles round a closed ring: 2π for a convex one, more for every wiggle. */
function totalTurning(ring: readonly Point[]): number {
  let total = 0;
  for (const [i, [x, y]] of ring.entries()) {
    const [px, py] = ring[(i + ring.length - 1) % ring.length] ?? [x, y];
    const [nx, ny] = ring[(i + 1) % ring.length] ?? [x, y];
    const turn =
      Math.atan2(ny - y, nx - x) - Math.atan2(y - py, x - px) + 3 * Math.PI;
    total += Math.abs((turn % (2 * Math.PI)) - Math.PI);
  }
  return total;
}

function expectEncloses(
  outline: ArchipelagoOutline,
  islands: readonly HullIsland[],
  padding: number
) {
  for (const island of islands) {
    for (const point of coastPoints(island)) {
      expect(inside(outline.points, point)).toBe(true);
      expect(distanceTo(outline.points, point)).toBeGreaterThanOrEqual(
        padding - 1e-6
      );
    }
  }
}

it("encloses the reference archipelago in one outline with its padding to spare", async () => {
  const data = await loadSpyglass();
  const islands = islandsOf(data);
  const outlines = archipelagoOutline({ islands });
  expect(outlines).toHaveLength(1);
  const [outline] = outlines;
  if (!outline) {
    throw new Error("No outline.");
  }
  expect(outline.group).toBe("");
  expect([...outline.islands].sort()).toEqual(
    islands.map(({ id }) => id).sort()
  );
  expectEncloses(outline, islands, defaultHullSettings.padding);
  expect(outline.clearance).toBeGreaterThanOrEqual(defaultHullSettings.padding);
  // The padding is a floor, not a halo: the outline stays near it.
  expect(outline.clearance).toBeLessThan(defaultHullSettings.padding * 1.5);
});

it("is far smoother and simpler than the terrain's silhouette", async () => {
  const data = await loadSpyglass();
  const [outline] = archipelagoOutline({ islands: islandsOf(data) });
  const silhouette = terrainSilhouette(chartTerrain(data)).map(
    (polygon) => polygon[0] ?? []
  );
  const silhouetteVertices = silhouette.reduce(
    (sum, ring) => sum + ring.length,
    0
  );
  const silhouetteTurning = silhouette.reduce(
    (sum, ring) => sum + totalTurning(ring),
    0
  );
  const points = outline?.points ?? [];
  expect(points.length).toBeGreaterThan(16);
  expect(points.length).toBeLessThan(silhouetteVertices / 2);
  // A smooth simple ring turns about once; the silhouette wanders.
  expect(totalTurning(points)).toBeLessThan(2 * Math.PI * 1.6);
  expect(totalTurning(points)).toBeLessThan(silhouetteTurning / 2);
  // No corner: every turn is gentle.
  for (const [i, [x, y]] of points.entries()) {
    const [px, py] = points[(i + points.length - 1) % points.length] ?? [x, y];
    const [nx, ny] = points[(i + 1) % points.length] ?? [x, y];
    const turn = Math.abs(
      ((Math.atan2(ny - y, nx - x) - Math.atan2(y - py, x - px) + 3 * Math.PI) %
        (2 * Math.PI)) -
        Math.PI
    );
    expect(turn).toBeLessThan(Math.PI / 6);
  }
});

it("gives the same outline every time and in any island order", async () => {
  const data = await loadSpyglass();
  const islands = islandsOf(data);
  const first = archipelagoOutline({ islands });
  expect(archipelagoOutline({ islands })).toEqual(first);
  const shuffled = [...islands].sort((a, b) => b.id.localeCompare(a.id));
  expect(archipelagoOutline({ islands: shuffled })).toEqual(first);
});

it("draws one separate outline per frame", async () => {
  const data = await loadSpyglass();
  const islands = islandsOf(data);
  const middle = [...islands].sort((a, b) => a.x - b.x)[
    Math.floor(islands.length / 2)
  ];
  const west = islands
    .filter((island) => island.x < (middle?.x ?? 0))
    .map((island) => ({ ...island, group: "west" }));
  const east = islands
    .filter((island) => island.x >= (middle?.x ?? 0))
    .map((island) => ({ ...island, group: "east", x: island.x + 1600 }));
  const outlines = archipelagoOutline({ islands: [...west, ...east] });
  expect(outlines.map(({ group }) => group)).toEqual(["east", "west"]);
  const [eastOutline, westOutline] = outlines;
  if (!(eastOutline && westOutline)) {
    throw new Error("Expected two outlines.");
  }
  expectEncloses(eastOutline, east, defaultHullSettings.padding);
  expectEncloses(westOutline, west, defaultHullSettings.padding);
  for (const point of east.flatMap(coastPoints)) {
    expect(inside(westOutline.points, point)).toBe(false);
  }
  for (const point of west.flatMap(coastPoints)) {
    expect(inside(eastOutline.points, point)).toBe(false);
  }
});

it("places the rings as the old open sea stepped: each gap wider than the last", () => {
  const { rings } = defaultHullSettings;
  for (let index = 0; index <= 12; index += 1) {
    expect(ringCoordinate(ringOffset(index, rings), rings)).toBeCloseTo(
      index,
      9
    );
    expect(ringOffset(index + 1, rings) - ringOffset(index, rings)).toBeCloseTo(
      rings.first + rings.growth * index,
      9
    );
  }
  expect(ringCoordinate(-rings.first, rings)).toBeCloseTo(-1, 9);
  expect(ringCoordinate(0, rings)).toBe(0);
});

it("bakes a signed field over the whole sea: rings rising outward, a gradient from 0 to 1", async () => {
  const data = await loadSpyglass();
  const outlines = archipelagoOutline({ islands: islandsOf(data) });
  const extent = chartSeaBounds(data);
  const field = emanationField(outlines, extent);
  expect(Math.max(field.width, field.height)).toBe(
    defaultHullSettings.resolution
  );
  expect(field.width * field.cell).toBeCloseTo(extent.width, -1);
  expect(field.height * field.cell).toBeCloseTo(extent.height, -1);
  expect(field.left).toBeCloseTo((-field.width * field.cell) / 2, 6);
  // Inside the outline at the islands, outside at the sea's corners.
  const [island] = data.territories;
  expect(
    sampleGrid(field, field.distance, island?.x ?? 0, island?.y ?? 0)
  ).toBeLessThan(0);
  expect(field.distance[0]).toBeGreaterThan(0);
  expect(field.distance.at(-1)).toBeGreaterThan(0);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const [at, gradient] of field.gradient.entries()) {
    low = Math.min(low, gradient);
    high = Math.max(high, gradient);
    expect(Number.isFinite(field.ring[at])).toBe(true);
    expect(field.terraced[at]).toBeGreaterThanOrEqual(0);
    expect(field.terraced[at]).toBeLessThanOrEqual(1);
    if ((field.distance[at] ?? 0) <= 0) {
      expect(gradient).toBe(0);
    }
  }
  expect(low).toBe(0);
  expect(high).toBe(1);
  // The outermost cells reach 1 all round.
  expect(field.gradient[0]).toBe(1);
  expect(field.gradient[field.width - 1]).toBe(1);
  // Along every ray out from the archipelago the rings only rise, and pass many.
  const points = outlines[0]?.points ?? [];
  const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const reach = Math.min(extent.width, extent.height) / 2 - field.cell;
  for (let ray = 0; ray < 16; ray += 1) {
    const angle = (ray / 16) * Math.PI * 2;
    let previous = Number.NEGATIVE_INFINITY;
    for (let step = 0; step <= 400; step += 1) {
      const r = (reach * step) / 400;
      const ring = sampleGrid(
        field,
        field.ring,
        cx + r * Math.cos(angle),
        cy + r * Math.sin(angle)
      );
      if (ring > 0) {
        expect(ring).toBeGreaterThanOrEqual(previous - 1e-4);
      }
      previous = Math.max(previous, ring);
    }
    expect(previous).toBeGreaterThan(8);
  }
});

it("joins two frames' rings without a seam", async () => {
  const data = await loadSpyglass();
  const islands = islandsOf(data);
  const west = islands
    .filter((island) => island.x < 0)
    .map((island) => ({ ...island, group: "west", x: island.x - 600 }));
  const east = islands
    .filter((island) => island.x >= 0)
    .map((island) => ({ ...island, group: "east", x: island.x + 600 }));
  const outlines = archipelagoOutline({ islands: [...west, ...east] });
  expect(outlines).toHaveLength(2);
  const field = emanationField(outlines, chartSeaBounds(data));
  // A ring coordinate never jumps between neighbouring cells: at most one
  // first gap's worth per cell, with room for the far rings' rounding.
  const limit = (1.5 * field.cell) / defaultHullSettings.rings.first;
  for (let row = 0; row < field.height; row += 1) {
    for (let column = 1; column < field.width; column += 1) {
      const at = row * field.width + column;
      expect(
        Math.abs((field.ring[at] ?? 0) - (field.ring[at - 1] ?? 0))
      ).toBeLessThan(limit);
    }
  }
});

it("leaves the sea flat with no outline", () => {
  const field = emanationField([], { height: 400, width: 600 });
  expect(field.gradient.every((value) => value === 0)).toBe(true);
  expect(field.ring.every((value) => value === 0)).toBe(true);
  expect(archipelagoOutline({ islands: [] })).toEqual([]);
});

it("traces each ring as the field places it: an offset of the outline by `ringOffset`", () => {
  const square: [number, number][] = [
    [-40, -40],
    [40, -40],
    [40, 40],
    [-40, 40],
  ];
  const settings = {
    ...defaultHullSettings,
    resolution: 150,
    rings: {
      first: 30,
      growth: 10,
      rounding: { radius: 0, reach: 1 },
      softness: 0.3,
    },
  };
  const field = emanationField(
    [{ points: square }],
    { height: 400, width: 600 },
    settings
  );
  const rings = hullRings(field, settings.rings);
  const indices = [...new Set(rings.map(({ index }) => index))];
  // The sea's edge stands 160 map units over the square and 260 beside it.
  expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
  for (const ring of rings) {
    expect(ring.offset).toBe(ringOffset(ring.index, settings.rings));
    expect(ring.closed).toBe(ring.index <= 3);
    for (const point of ring.points) {
      expect(Math.abs(distanceTo(square, point) - ring.offset)).toBeLessThan(
        field.cell
      );
    }
  }
  // One closed ring round the square at each index the sea holds whole.
  expect(rings.filter(({ closed }) => closed)).toHaveLength(4);
  // The top and bottom edges cut ring 4 into two pieces; ring 5 too.
  expect(rings.filter(({ index }) => index === 4)).toHaveLength(2);
  expect(hullRings(emanationField([], { height: 400, width: 600 }))).toEqual(
    []
  );
});

it("hands out the reference sea's rings on the field's own ring lines", async () => {
  const data = await loadSpyglass();
  const outlines = archipelagoOutline({ islands: islandsOf(data) });
  const field = emanationField(outlines, chartSeaBounds(data));
  const rings = hullRings(field);
  const highest = Math.floor(
    field.ring.reduce((most, value) => Math.max(most, value), 0)
  );
  expect([...new Set(rings.map(({ index }) => index))]).toEqual(
    Array.from({ length: highest + 1 }, (_, index) => index)
  );
  const right = field.left + field.width * field.cell;
  const bottom = field.top + field.height * field.cell;
  for (const ring of rings) {
    expect(ring.points.length).toBeGreaterThanOrEqual(ring.closed ? 3 : 2);
    for (const [x, y] of ring.points) {
      expect(
        Math.abs(sampleGrid(field, field.ring, x, y) - ring.index)
      ).toBeLessThan(1e-3);
      expect(x).toBeGreaterThan(field.left);
      expect(x).toBeLessThan(right);
      expect(y).toBeGreaterThan(field.top);
      expect(y).toBeLessThan(bottom);
    }
  }
  // The near rings close round the archipelago; the sea's edge cuts the far ones.
  expect(rings.find(({ index }) => index === 0)?.closed).toBe(true);
  expect(rings.filter(({ index }) => index === highest)).not.toHaveLength(0);
  expect(rings.some(({ closed }) => !closed)).toBe(true);
});
