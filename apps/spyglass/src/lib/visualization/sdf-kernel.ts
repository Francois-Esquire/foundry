import type { KernelMath } from "./terrain-kernel";

/**
 * The SDF trial's slab field as a terrain kernel: one island's signed
 * distance at a point from the lattice columns round it, over any
 * backend, so the CPU reference (`sdf-island.ts`) and the GPU's compute
 * passes evaluate the same formula op for op. Also the least-squares
 * vertex of dual contouring, in the closed form the GPU solves.
 */

/** Where each value sits in a lattice column, `columnStride` floats a column. */
export const columnSlots = {
  /** World units over its coast of the land; at sea the ground, never over the water. */
  distance: 8,
  /** World height of the ground: the seabed, and the lagoon's floor. */
  groundHeight: 1,
  /** `1 / √(1 + |∇ground|²)`, the ground's normalisation. */
  groundScale: 2,
  /** The land's elevation (geology units), at sea the ground's below the water. */
  land: 0,
  /** Index of the island whose coast lies nearest, -1 where none is listed. */
  owner: 3,
  /** Each slab's tread normalisation, four slots. */
  treadScale: 4,
} as const;

/** Floats a lattice column takes: three four-float texels. */
export const columnStride = 12;

/** Slabs a profile holds: the beach bench and up to three terraces. */
export const slabCount = 4;

/** One slab of an island: its tread's elevation band and its wall. */
interface Slab {
  /** Tread's elevation band (geology units): the land held within it, level beyond. */
  high: number;
  low: number;
  /** World height at the wall's middle. */
  middle: number;
  /** Map units added to the footprint's distance, so the wall's middle stands at 0. */
  offset: number;
  /** World units of the wall's rise a map unit across. */
  slope: number;
}

/** An island's slabs and how they join. */
export interface SlabProfile {
  exaggeration: number;
  /** Radius of the smooth minimum at a wall's foot, world units. */
  foot: number;
  /** The bench first; slots past the island's terraces are left out. */
  slabs: readonly Slab[];
}

/** Floats a packed profile takes: five a slab, then the foot and exaggeration, padded to whole texels. */
export const profileStride = 24;

/** A slab nothing can reach: its wall and tread far below any ground. */
const absent: Slab = {
  high: -1e4,
  low: -1e4,
  middle: -1e5,
  offset: 0,
  slope: 1,
};

/** A profile as plain numbers, for a uniform array: each slab's five values, absent slabs filled, then foot and exaggeration. */
export function packSlabProfile(profile: SlabProfile): number[] {
  const values = new Array<number>(profileStride).fill(0);
  for (let index = 0; index < slabCount; index += 1) {
    const slab = profile.slabs[index] ?? absent;
    values.splice(
      index * 5,
      5,
      slab.low,
      slab.high,
      slab.middle,
      slab.offset,
      slab.slope
    );
  }
  values[slabCount * 5] = profile.foot;
  values[slabCount * 5 + 1] = profile.exaggeration;
  return values;
}

/** A polynomial smooth minimum of radius `k`; its gradient is a convex blend of its arguments'. */
function kernelSmoothMin<F, U, B>(
  m: KernelMath<F, U, B>,
  a: F,
  b: F,
  k: number | F
): F {
  const h = m.keep(m.div(m.max(m.sub(k, m.abs(m.sub(a, b))), 0), k));
  return m.sub(m.min(a, b), m.div(m.mul(m.mul(h, h), k), 4));
}

/**
 * The island's signed distance at height `z` over a point, from the four
 * lattice columns round it (`column(corner, slot)`, corners in any order)
 * and their bilinear `weights`; `profile(slot)` reads the packed profile.
 * The ground, then each slab, a level tread cut by its wall, joined by a
 * smooth minimum at the foot; the lip is a sharp maximum.
 */
export function kernelSlabField<F, U, B>(
  m: KernelMath<F, U, B>,
  column: (corner: number, slot: number) => F,
  weights: readonly F[],
  z: F,
  profile: (slot: number) => F | number
): F {
  const bilinear = (slot: number) => {
    let sum: F = m.float(0);
    for (const [corner, weight] of weights.entries()) {
      sum = m.add(sum, m.mul(weight, column(corner, slot)));
    }
    return sum;
  };
  const exaggeration = profile(slabCount * 5 + 1);
  const foot = profile(slabCount * 5);
  // Each running value is held, so a shader builds it once, not once per read.
  let solid = m.keep(
    m.mul(
      m.sub(z, bilinear(columnSlots.groundHeight)),
      bilinear(columnSlots.groundScale)
    )
  );
  for (let index = 0; index < slabCount; index += 1) {
    const at = (offset: number) => profile(index * 5 + offset);
    let tread: F = m.float(0);
    for (const [corner, weight] of weights.entries()) {
      const land = column(corner, columnSlots.land);
      tread = m.add(tread, m.mul(weight, m.min(at(1), m.max(at(0), land))));
    }
    const top = m.mul(
      m.sub(z, m.mul(tread, exaggeration)),
      bilinear(columnSlots.treadScale + index)
    );
    const slope = at(4);
    const side = m.div(
      m.sub(
        m.add(
          m.mul(m.add(bilinear(columnSlots.distance + index), at(3)), slope),
          z
        ),
        at(2)
      ),
      m.sqrt(m.add(1, m.mul(slope, slope)))
    );
    solid = m.keep(
      kernelSmoothMin(m, solid, m.keep(m.max(m.keep(top), m.keep(side))), foot)
    );
  }
  return solid;
}

/**
 * The ridge a crossing adds to dual contouring's normal equations: a
 * hundredth of the plane's own weight, so a direction the planes leave
 * free stays at the mass point while any the planes pin is solved.
 */
export const qefRidge = 0.01;

/**
 * Dual contouring's vertex in closed form, about the crossings' mass
 * point: `(AᵀA + λI) x = Aᵀb`, where each crossing adds its plane `n·x =
 * n·p` relative to the mass point. The ridge λ keeps the directions the
 * planes leave free at the mass point, as truncating small eigenvalues
 * does, so a flat patch's vertex stays central and an edge's or corner's
 * goes onto it. `ata` holds xx, xy, xz, yy, yz, zz; returns the offset
 * from the mass point.
 */
export function kernelQefOffset<F, U, B>(
  m: KernelMath<F, U, B>,
  ata: readonly [F, F, F, F, F, F],
  atb: readonly [F, F, F],
  ridge: F | number
): [F, F, F] {
  const [xx0, xy, xz, yy0, yz, zz0] = ata;
  const xx = m.add(xx0, ridge);
  const yy = m.add(yy0, ridge);
  const zz = m.add(zz0, ridge);
  // The adjugate of the symmetric matrix, over its determinant.
  const c00 = m.sub(m.mul(yy, zz), m.mul(yz, yz));
  const c01 = m.sub(m.mul(xz, yz), m.mul(xy, zz));
  const c02 = m.sub(m.mul(xy, yz), m.mul(xz, yy));
  const c11 = m.sub(m.mul(xx, zz), m.mul(xz, xz));
  const c12 = m.sub(m.mul(xy, xz), m.mul(xx, yz));
  const c22 = m.sub(m.mul(xx, yy), m.mul(xy, xy));
  const determinant = m.add(
    m.add(m.mul(xx, c00), m.mul(xy, c01)),
    m.mul(xz, c02)
  );
  const [bx, by, bz] = atb;
  const solve = (a: F, b: F, c: F) =>
    m.div(m.add(m.add(m.mul(a, bx), m.mul(b, by)), m.mul(c, bz)), determinant);
  return [solve(c00, c01, c02), solve(c01, c11, c12), solve(c02, c12, c22)];
}
