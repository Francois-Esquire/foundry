import { elevationAtDepth } from "./geology";
import type { Lagoon, LagoonSettings } from "./lagoons";
import type { KernelMath } from "./terrain-kernel";
import type { KernelNoise } from "./terrain-kernel-noise";

/**
 * `lagoons.ts`'s water as a terrain kernel: an atoll's lagoon, its inlets
 * and patch reefs carved into its land at a position, over any backend,
 * from a block of the island's record. The plan (where the lagoon's shore
 * lies, the inlets' centre lines, the reefs, the seeds) stays the CPU's;
 * the kernel holds the arithmetic, op for op.
 */

/** Patch reefs a record holds; a lagoon of under 5,600 square map units has fewer. */
const lagoonReefs = 8;
/** Inlets a record holds: one, or two through a large lagoon. */
const lagoonInlets = 2;
/** Points along an inlet's centre line, as `lagoons.ts` traces it. */
const inletPoints = 25;

const reefStride = 3;
/** Active, bounds (4), coast, lagoon, seed halves (2), points (2 each), lengths. */
const inletStride = 9 + inletPoints * 3;

/** Where each value sits in a lagoon's block. */
const lagoonSlots = {
  beachHeight: 3,
  depth: 1,
  floorSeed: 4,
  has: 0,
  inlets: 8 + lagoonReefs * reefStride,
  reefs: 8,
  shore: 2,
  shoreSeed: 6,
} as const;

/** Floats a lagoon's block takes. */
export const lagoonStride = lagoonSlots.inlets + lagoonInlets * inletStride;

/** A 32-bit seed as two exact 16-bit halves, high first. */
function seedHalves(seed: number): [number, number] {
  return [Math.floor(seed / 65_536), seed % 65_536];
}

/** One lagoon's block, plain numbers; an island without a lagoon reads `has` 0. */
export function packLagoon(lagoon: Lagoon | undefined): number[] {
  const values = new Array<number>(lagoonStride).fill(0);
  if (!lagoon) {
    return values;
  }
  values[lagoonSlots.has] = 1;
  values[lagoonSlots.depth] = lagoon.depth;
  values[lagoonSlots.shore] = lagoon.shore;
  values[lagoonSlots.beachHeight] = lagoon.beachHeight;
  const [floorHigh, floorLow] = seedHalves(lagoon.seeds.floor);
  const [shoreHigh, shoreLow] = seedHalves(lagoon.seeds.shore);
  values[lagoonSlots.floorSeed] = floorHigh;
  values[lagoonSlots.floorSeed + 1] = floorLow;
  values[lagoonSlots.shoreSeed] = shoreHigh;
  values[lagoonSlots.shoreSeed + 1] = shoreLow;
  for (const [index, reef] of lagoon.reefs.slice(0, lagoonReefs).entries()) {
    const at = lagoonSlots.reefs + index * reefStride;
    values[at] = reef.x;
    values[at + 1] = reef.y;
    values[at + 2] = reef.radius;
  }
  for (const [index, inlet] of lagoon.inlets.slice(0, lagoonInlets).entries()) {
    const at = lagoonSlots.inlets + index * inletStride;
    const [high, low] = seedHalves(inlet.seed);
    values.splice(
      at,
      9,
      1,
      inlet.bounds.left,
      inlet.bounds.top,
      inlet.bounds.right,
      inlet.bounds.bottom,
      inlet.coast,
      inlet.lagoon,
      high,
      low
    );
    for (let point = 0; point < inletPoints; point += 1) {
      // A shorter line repeats its last point: a segment of no length.
      const last = Math.min(point, inlet.points.length - 1);
      const [x = 0, y = 0] = inlet.points[last] ?? [];
      values[at + 9 + point * 2] = x;
      values[at + 9 + point * 2 + 1] = y;
      values[at + 9 + inletPoints * 2 + point] = inlet.lengths[last] ?? 0;
    }
  }
  return values;
}

/** The knots of `nominalDepth`, nominal metres and elevation, shallow first. */
const depthKnots = [0, 5, 20, 100, 500, 1000, 2000, 4000].map((depth) => ({
  depth,
  elevation: elevationAtDepth(depth),
}));

/**
 * `elevationAtDepth` over a backend: 0 above the water, linear between
 * the knots, the trench floor past the last, each span's formula as
 * `geology.ts` writes it.
 */
export function kernelElevationAtDepth<F, U, B>(
  m: KernelMath<F, U, B>,
  depth: F
): F {
  const last = depthKnots.at(-1) ?? { depth: 0, elevation: 0 };
  let value: F = m.float(last.elevation);
  // From the deepest span up, so the shallowest span that holds the depth wins.
  for (let index = depthKnots.length - 1; index >= 1; index -= 1) {
    const upper = depthKnots[index - 1];
    const lower = depthKnots[index];
    if (upper && lower) {
      const between = m.add(
        upper.elevation,
        m.mul(
          m.div(m.sub(depth, upper.depth), lower.depth - upper.depth),
          lower.elevation - upper.elevation
        )
      );
      value = m.select(m.lt(lower.depth, depth), value, between);
    }
  }
  return m.select(m.lt(0, depth), value, 0);
}

/**
 * The lagoon's carve of an atoll's land at a sample, as `lagoonLandform`
 * gives it: below the water inside the lagoon or an inlet, held to the
 * inner beach on the land round them, and the land as it is anywhere else,
 * on another piece of land, or on an island without a lagoon. `height` is
 * the landform's, `read` the island's lagoon block at a slot known when
 * the kernel is built and `readAt` at one computed in it.
 */
export function kernelLagoon<F, U, B>(
  m: KernelMath<F, U, B>,
  noise: KernelNoise<F, U>,
  read: (slot: number) => F,
  readAt: (slot: F) => F,
  sample: { height: F; inland: F; pieceDepth: F; x: F; y: F },
  settings: LagoonSettings
): F {
  // Held before the branch, which reads them inside it.
  const height = m.keep(sample.height);
  const x = m.keep(sample.x);
  const y = m.keep(sample.y);
  const inland = m.keep(sample.inland);
  const pieceDepth = m.keep(sample.pieceDepth);
  // Only an atoll's record has a lagoon; every other island skips the carve.

  return m.branch(read(lagoonSlots.has), [
    () => height,
    () =>
      carveLagoon(
        m,
        noise,
        { read, readAt },
        { height, inland, pieceDepth, x, y },
        settings
      ),
  ]);
}

/** The carve itself, for an island whose record holds a lagoon. */
function carveLagoon<F, U, B>(
  m: KernelMath<F, U, B>,
  noise: KernelNoise<F, U>,
  record: { read: (slot: number) => F; readAt: (slot: F) => F },
  sample: { height: F; inland: F; pieceDepth: F; x: F; y: F },
  settings: LagoonSettings
): F {
  const { read } = record;
  const smoothstep = (low: F | number, high: F | number, value: F | number) => {
    const t = m.min(1, m.max(0, m.div(m.sub(value, low), m.sub(high, low))));
    return m.mul(m.mul(t, t), m.sub(3, m.mul(2, t)));
  };
  const { x, y } = sample;
  const seed = (slot: number) => m.uintFromHalves(read(slot), read(slot + 1));
  const lagoonDepth = read(lagoonSlots.depth);
  const { depth: depths, floor, shore } = settings;

  // `lagoonEdge`: map units into the water, the shore wandering with noise.
  const shoreOffset = m.mul(
    shore.amplitude,
    noise.fbm(
      m.div(x, shore.wavelength),
      m.div(y, shore.wavelength),
      seed(lagoonSlots.shoreSeed),
      shore
    )
  );
  const lagoonAt = m.sub(
    m.sub(sample.inland, read(lagoonSlots.shore)),
    shoreOffset
  );
  const relief = m.mul(
    floor.amplitude,
    noise.fbm(
      m.div(x, floor.wavelength),
      m.div(y, floor.wavelength),
      seed(lagoonSlots.floorSeed),
      floor
    )
  );
  // `floorDepth`: shallow at the edge, deepening toward the middle.
  const floorDepth = (into: F | number): F => {
    const span = m.max(1, m.sub(lagoonDepth, read(lagoonSlots.shore)));
    const basin = m.add(
      depths.shore,
      m.mul(
        depths.centre - depths.shore,
        smoothstep(0, settings.basin, m.div(into, span))
      )
    );
    return m.max(
      depths.shore,
      m.add(basin, m.mul(relief, smoothstep(0, settings.bank, into)))
    );
  };
  const banked = (full: F | number, into: F | number, bank: number): F =>
    m.add(
      depths.edge,
      m.mul(m.sub(full, depths.edge), smoothstep(0, bank, into))
    );
  let edge: F = lagoonAt;
  let depth: F = m.select(
    m.lt(0, lagoonAt),
    banked(floorDepth(lagoonAt), lagoonAt, settings.bank),
    0
  );

  // The inlets: the distance to each centre line and its depth along it.
  // `inletDepth` starts from the lagoon's floor at its bank.
  const start = floorDepth(settings.bank);
  for (let index = 0; index < lagoonInlets; index += 1) {
    const inlet = inletAt(m, noise, record, index, { x, y }, settings);
    const inletDepth = inletDepthAt(m, inlet, start, settings);
    edge = m.select(inlet.within, m.max(edge, inlet.inside), edge);
    depth = m.select(
      m.and(inlet.within, m.lt(0, inlet.inside)),
      m.max(depth, banked(inletDepth, inlet.inside, settings.inlet.bank)),
      depth
    );
  }

  // `reefDepth`: patch reefs rising toward the surface.
  let reefed: F = depth;
  for (let index = 0; index < lagoonReefs; index += 1) {
    const at = lagoonSlots.reefs + index * reefStride;
    const radius = read(at + 2);
    const t = m.div(
      m.hypot(m.sub(x, read(at)), m.sub(y, read(at + 1))),
      m.max(radius, 1e-9)
    );
    const crest = m.add(
      settings.reefs.top,
      m.mul(m.sub(depth, settings.reefs.top), smoothstep(0.25, 1, t))
    );
    reefed = m.select(
      m.and(m.lt(0, radius), m.lt(t, 1)),
      m.min(reefed, crest),
      reefed
    );
  }
  depth = m.select(m.lt(0, edge), reefed, depth);

  // `innerBeach`, `edge` map units back from the water.
  const back = m.mul(edge, -1);
  const { beach } = settings;
  const innerBeach = m.select(
    m.lt(beach.width, back),
    m.add(
      read(lagoonSlots.beachHeight),
      m.mul(m.sub(back, beach.width), beach.rise)
    ),
    m.mul(read(lagoonSlots.beachHeight), smoothstep(0, beach.lip, back))
  );
  const carved = m.select(
    m.lt(0, edge),
    kernelElevationAtDepth(m, depth),
    m.min(sample.height, innerBeach)
  );
  const ownPiece = m.lt(m.abs(m.sub(sample.pieceDepth, lagoonDepth)), 1e-3);
  return m.select(ownPiece, carved, sample.height);
}

/** One inlet at a point: whether the point lies in its bounds, how far inside its banks, and how far along its centre line. */
interface InletSample<F, B> {
  along: F;
  /** Map units along the line where it crosses the coast. */
  coast: F;
  inside: F;
  /** Map units along the line where it leaves the lagoon. */
  lagoon: F;
  within: B;
}

function kernelSmoothstep<F, U, B>(m: KernelMath<F, U, B>) {
  return (low: F | number, high: F | number, value: F | number): F => {
    const t = m.min(1, m.max(0, m.div(m.sub(value, low), m.sub(high, low))));
    return m.mul(m.mul(t, t), m.sub(3, m.mul(2, t)));
  };
}

/**
 * Inlet `index` of a lagoon's block at a point, as `inletDistance` and
 * `inletHalfWidth` give it: the nearest point of its centre line, walked
 * as a loop in the shader, and its banks' half width there.
 */
function inletAt<F, U, B>(
  m: KernelMath<F, U, B>,
  noise: KernelNoise<F, U>,
  record: { read: (slot: number) => F; readAt: (slot: F) => F },
  index: number,
  point: { x: F; y: F },
  settings: LagoonSettings
): InletSample<F, B> {
  const { read, readAt } = record;
  const { x, y } = point;
  const smoothstep = kernelSmoothstep(m);
  const at = lagoonSlots.inlets + index * inletStride;
  const value = (slot: number) => read(at + slot);
  const within = m.and(
    m.and(m.lt(0.5, value(0)), m.lt(value(1), m.add(x, 1e-9))),
    m.and(
      m.and(m.lt(x, m.add(value(3), 1e-9)), m.lt(value(2), m.add(y, 1e-9))),
      m.lt(y, m.add(value(4), 1e-9))
    )
  );
  const [best = m.float(1e30), along = m.float(0)] = m.repeat(
    inletPoints - 1,
    [m.float(1e30), m.float(0)],
    (walked, [nearest = m.float(1e30), reached = m.float(0)]) => {
      const corner = (offset: number) =>
        readAt(m.add(at + 9 + offset, m.mul(walked, 2)));
      const length = (offset: number) =>
        readAt(m.add(at + 9 + inletPoints * 2 + offset, walked));
      const ax = corner(0);
      const ay = corner(1);
      const dx = m.sub(corner(2), ax);
      const dy = m.sub(corner(3), ay);
      const span = m.add(m.mul(dx, dx), m.mul(dy, dy));
      const t = m.select(
        m.lt(0, span),
        m.min(
          1,
          m.max(
            0,
            m.div(m.add(m.mul(m.sub(x, ax), dx), m.mul(m.sub(y, ay), dy)), span)
          )
        ),
        0
      );
      const distance = m.hypot(
        m.sub(m.sub(x, ax), m.mul(t, dx)),
        m.sub(m.sub(y, ay), m.mul(t, dy))
      );
      const from = length(0);
      const to = length(1);
      const closer = m.lt(distance, nearest);
      return [
        m.select(closer, distance, nearest),
        m.select(closer, m.add(from, m.mul(t, m.sub(to, from))), reached),
      ];
    }
  );
  const { inlet } = settings;
  const opening = smoothstep(value(6), m.add(value(5), inlet.width), along);
  // The banks only widen, so the throat is never narrower than `width`.
  const banks = m.add(
    1,
    m.div(
      m.mul(
        inlet.wander.share,
        m.add(
          noise.gradient(
            m.div(along, inlet.wander.wavelength),
            m.float(0.5),
            m.uintFromHalves(value(7), value(8))
          ),
          1
        )
      ),
      2
    )
  );
  const halfWidth = m.mul(
    m.mul(inlet.width / 2, m.add(1, m.mul(inlet.flare - 1, opening))),
    banks
  );
  return {
    along,
    coast: value(5),
    inside: m.sub(halfWidth, best),
    lagoon: value(6),
    within,
  };
}

/**
 * `inletDepth`: nominal metres over the centre line, from `start` where
 * it leaves the lagoon to the inlet's own depth at the coast, then fading
 * out over `reach` past it.
 */
function inletDepthAt<F, U, B>(
  m: KernelMath<F, U, B>,
  inlet: InletSample<F, B>,
  start: F | number,
  settings: LagoonSettings
): F {
  const smoothstep = kernelSmoothstep(m);
  const { depth, reach } = settings.inlet;
  const towardCoast = m.add(
    start,
    m.mul(
      m.sub(depth, start),
      smoothstep(inlet.lagoon, inlet.coast, inlet.along)
    )
  );
  const pastCoast = m.mul(
    depth,
    m.sub(
      1,
      smoothstep(
        0,
        1,
        m.div(m.sub(inlet.along, inlet.coast), Math.max(reach, 1e-6))
      )
    )
  );
  return m.select(m.lt(inlet.coast, inlet.along), pastCoast, towardCoast);
}

/**
 * `inletChannel`: the deepest an atoll's inlets carve the sea at a point,
 * nominal metres, or 0 where no channel runs: each inlet's seaward run
 * past the coast. `read` and `readAt` are the island's lagoon block.
 */
export function kernelInletChannel<F, U, B>(
  m: KernelMath<F, U, B>,
  noise: KernelNoise<F, U>,
  record: { read: (slot: number) => F; readAt: (slot: F) => F },
  point: { x: F; y: F },
  settings: LagoonSettings
): F {
  const x = m.keep(point.x);
  const y = m.keep(point.y);
  return m.branch(record.read(lagoonSlots.has), [
    () => m.float(0),
    () => {
      const smoothstep = kernelSmoothstep(m);
      const { inlet: inletSettings, depth } = settings;
      let deepest: F = m.float(0);
      for (let index = 0; index < lagoonInlets; index += 1) {
        const inlet = inletAt(m, noise, record, index, { x, y }, settings);
        const carved = m.add(
          depth.edge,
          m.mul(
            m.sub(
              inletDepthAt(m, inlet, inletSettings.depth, settings),
              depth.edge
            ),
            smoothstep(0, inletSettings.bank, inlet.inside)
          )
        );
        const runs = m.and(
          m.and(inlet.within, m.lt(0, inlet.inside)),
          m.lt(m.sub(inlet.coast, inletSettings.width), inlet.along)
        );
        deepest = m.select(runs, m.max(deepest, carved), deepest);
      }
      return deepest;
    },
  ]);
}
