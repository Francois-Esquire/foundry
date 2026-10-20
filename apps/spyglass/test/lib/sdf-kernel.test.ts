import { beforeAll, describe, expect, it } from "vitest";
import {
  type SdfIsland,
  sdfIsland,
} from "../../src/lib/visualization/sdf-island";
import {
  columnStride,
  kernelQefOffset,
  kernelSlabField,
  packSlabProfile,
  qefRidge,
} from "../../src/lib/visualization/sdf-kernel";
import {
  float32Math,
  type KernelMath,
} from "../../src/lib/visualization/terrain-kernel";
import { chartWorld } from "../../src/web/layout/chart-world";
import { loadSpyglass } from "../helpers/reference-spyglass";

type Math32 = KernelMath<number, number, boolean>;

let islands: SdfIsland[] = [];

beforeAll(async () => {
  const chart = chartWorld(await loadSpyglass());
  const pick = (archetype: string) =>
    [...chart.landforms]
      .filter(([, landform]) => landform.archetype === archetype)
      .sort(([, a], [, b]) => b.params.depth - a.params.depth)[0]?.[0] ?? "";
  islands = ["plateau", "atoll"].map((archetype) =>
    sdfIsland(chart.world, chart.landforms, pick(archetype))
  );
});

/** The slab field over `m` at a world point, its columns' weights computed in `m` too, as the GPU does. */
function fieldIn(
  m: Math32,
  island: SdfIsland,
  x: number,
  y: number,
  z: number
) {
  const { columns, fields } = island;
  const packed = packSlabProfile(island.slabs);
  const u = m.div(m.sub(x, fields.left), fields.spacing);
  const v = m.div(m.sub(-y, fields.top), fields.spacing);
  const column = Math.min(fields.columns - 2, Math.max(0, Math.floor(u)));
  const row = Math.min(fields.rows - 2, Math.max(0, Math.floor(v)));
  const s = Math.min(1, Math.max(0, m.sub(u, column)));
  const t = Math.min(1, Math.max(0, m.sub(v, row)));
  const i00 = row * fields.columns + column;
  const indices = [
    i00,
    i00 + 1,
    i00 + fields.columns,
    i00 + fields.columns + 1,
  ];
  const weights = [
    m.mul(m.sub(1, s), m.sub(1, t)),
    m.mul(s, m.sub(1, t)),
    m.mul(m.sub(1, s), t),
    m.mul(s, t),
  ];
  return kernelSlabField(
    m,
    (corner, slot) =>
      columns[(indices[corner] ?? 0) * columnStride + slot] ?? 0,
    weights,
    z,
    (slot) => packed[slot] ?? 0
  );
}

describe("the slab kernel in single precision", () => {
  it("matches the CPU's double-precision field near the surface to well under a lattice step", () => {
    for (const island of islands) {
      const { fields } = island;
      let worst = 0;
      let checked = 0;
      for (let row = 1; row < fields.rows - 1; row += 7) {
        for (let column = 1; column < fields.columns - 1; column += 7) {
          const x = fields.left + (column + 0.37) * fields.spacing;
          const y = -(fields.top + (row + 0.61) * fields.spacing);
          const surface = island.surfaceHeight(x, y);
          for (const dz of [-0.7, -0.2, 0.1, 0.45]) {
            const z = surface + dz;
            const exact = island.distance(x, y, z);
            if (Math.abs(exact) > 1) {
              continue;
            }
            worst = Math.max(
              worst,
              Math.abs(fieldIn(float32Math, island, x, y, z) - exact)
            );
            checked += 1;
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
      expect(worst).toBeLessThan(2e-3);
    }
  });
});

/** The vertex the closed-form solve puts among planes `(point, normal)`, in single precision. */
function vertex(points: number[][], normals: number[][]): number[] {
  const m = float32Math;
  const count = points.length;
  const mass = [0, 1, 2].map(
    (axis) => points.reduce((sum, p) => sum + (p[axis] ?? 0), 0) / count
  );
  const ata = [0, 0, 0, 0, 0, 0];
  const atb: [number, number, number] = [0, 0, 0];
  for (const [index, p] of points.entries()) {
    const [nx = 0, ny = 0, nz = 0] = normals[index] ?? [];
    const b =
      nx * ((p[0] ?? 0) - (mass[0] ?? 0)) +
      ny * ((p[1] ?? 0) - (mass[1] ?? 0)) +
      nz * ((p[2] ?? 0) - (mass[2] ?? 0));
    const products = [nx * nx, nx * ny, nx * nz, ny * ny, ny * nz, nz * nz];
    for (const [slot, value] of products.entries()) {
      ata[slot] = m.add(ata[slot] ?? 0, value);
    }
    atb[0] = m.add(atb[0], nx * b);
    atb[1] = m.add(atb[1], ny * b);
    atb[2] = m.add(atb[2], nz * b);
  }
  const offset = kernelQefOffset(
    m,
    ata as [number, number, number, number, number, number],
    atb,
    qefRidge * count
  );
  return offset.map((value, axis) => value + (mass[axis] ?? 0));
}

describe("dual contouring's closed-form vertex", () => {
  it("finds where three planes meet", () => {
    const solved = vertex(
      [
        [0.3, 0.9, 0.1],
        [0.8, 0.2, 0.4],
        [0.1, 0.5, 0.7],
      ],
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]
    );
    // The ridge damps the offset from the mass point by a few hundredths.
    const corner = [0.3, 0.2, 0.7];
    for (const [axis, value] of corner.entries()) {
      expect(Math.abs((solved[axis] ?? 0) - value)).toBeLessThan(0.015);
    }
  });

  it("puts a lip's vertex on its edge and leaves it central along it", () => {
    // A tread (z = 0.6) meeting a wall (x = 0.4), crossings either side.
    const solved = vertex(
      [
        [0.1, 0.2, 0.6],
        [0.2, 0.9, 0.6],
        [0.4, 0.3, 0.1],
        [0.4, 0.8, 0.3],
      ],
      [
        [0, 0, 1],
        [0, 0, 1],
        [1, 0, 0],
        [1, 0, 0],
      ]
    );
    expect(Math.abs((solved[0] ?? 0) - 0.4)).toBeLessThan(0.01);
    expect(Math.abs((solved[2] ?? 0) - 0.6)).toBeLessThan(0.01);
    expect(solved[1]).toBeCloseTo(0.55, 5);
  });

  it("keeps a flat patch's vertex at its crossings' mass point", () => {
    const solved = vertex(
      [
        [0, 0, 0.5],
        [1, 0, 0.5],
        [0, 1, 0.5],
      ],
      [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
      ]
    );
    expect(solved[0]).toBeCloseTo(1 / 3, 5);
    expect(solved[1]).toBeCloseTo(1 / 3, 5);
    expect(solved[2]).toBeCloseTo(0.5, 5);
  });
});
