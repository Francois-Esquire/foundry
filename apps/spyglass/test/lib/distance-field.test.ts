import { expect, it } from "vitest";
import { shoreDistances } from "../../src/lib/visualization/distance-field";
import { fillPolygon } from "../../src/lib/visualization/scanline-fill";
import { chartTerrain } from "../../src/web/layout/chart-terrain";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** The transform as it was first written, over plain arrays: the reference the typed one must equal bit for bit. */
function referenceDistances(
  land: Uint8Array,
  width: number,
  height: number
): Float32Array {
  const distances = Float32Array.from(land, (cell) =>
    cell ? 0 : (width + height) ** 2
  );
  for (let y = 0; y < height; y += 1) {
    distances.set(
      referenceLine(Array.from(distances.slice(y * width, (y + 1) * width))),
      y * width
    );
  }
  for (let x = 0; x < width; x += 1) {
    const column = referenceLine(
      Array.from({ length: height }, (_, y) => distances[y * width + x] ?? 0)
    );
    for (const [y, distance] of column.entries()) {
      distances[y * width + x] = Math.sqrt(distance);
    }
  }
  return distances;
}

function referenceLine(values: number[]): number[] {
  const sites = [0];
  const boundaries = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  let k = 0;
  for (let q = 1; q < values.length; q += 1) {
    let intersection = 0;
    let searching = true;
    while (searching) {
      const site = sites[k] ?? 0;
      intersection =
        ((values[q] ?? 0) + q * q - (values[site] ?? 0) - site * site) /
        (2 * (q - site));
      if (intersection > (boundaries[k] ?? Number.NEGATIVE_INFINITY)) {
        searching = false;
      } else {
        k -= 1;
      }
    }
    k += 1;
    sites[k] = q;
    boundaries[k] = intersection;
    boundaries[k + 1] = Number.POSITIVE_INFINITY;
  }
  k = 0;
  return values.map((_, q) => {
    while ((boundaries[k + 1] ?? Number.POSITIVE_INFINITY) < q) {
      k += 1;
    }
    const site = sites[k] ?? 0;
    return (q - site) ** 2 + (values[site] ?? 0);
  });
}

/** Whether two fields hold the same 32-bit values, NaN included. */
function identical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const right = new Uint32Array(b.buffer, b.byteOffset, b.length);
  return left.every((word, at) => word === right[at]);
}

/** A deterministic sparse mask from a linear congruential sequence. */
function scattered(width: number, height: number, share: number): Uint8Array {
  let state = width * 7919 + height;
  return Uint8Array.from({ length: width * height }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 < share ? 1 : 0;
  });
}

it("matches the reference transform bit for bit on scattered and degenerate masks", () => {
  const cases: [Uint8Array, number, number][] = [
    [scattered(37, 23, 0.02), 37, 23],
    [scattered(64, 64, 0.3), 64, 64],
    [scattered(1, 50, 0.1), 1, 50],
    [scattered(50, 1, 0.1), 50, 1],
    [new Uint8Array(30 * 20), 30, 20],
    [new Uint8Array(30 * 20).fill(1), 30, 20],
    [new Uint8Array(0), 0, 0],
  ];
  for (const [land, width, height] of cases) {
    expect(
      identical(
        shoreDistances(land, width, height),
        referenceDistances(land, width, height)
      )
    ).toBe(true);
  }
});

it("matches the reference transform bit for bit on the fixture's coasts", async () => {
  const data = await loadSpyglass();
  const terrain = chartTerrain(data);
  const land = new Uint8Array(terrain.width * terrain.height);
  for (const territory of data.territories) {
    for (const polygon of territory.coast) {
      fillPolygon(
        land,
        terrain.width,
        terrain.height,
        polygon.map((ring) =>
          ring.map(([x, y]): [number, number] => [
            (territory.x + x - terrain.left) / terrain.cell,
            (territory.y + y - terrain.top) / terrain.cell,
          ])
        )
      );
    }
  }
  expect(land.includes(1)).toBe(true);
  const water = Uint8Array.from(land, (cell) => 1 - cell);
  for (const mask of [land, water]) {
    expect(
      identical(
        shoreDistances(mask, terrain.width, terrain.height),
        referenceDistances(mask, terrain.width, terrain.height)
      )
    ).toBe(true);
  }
});
