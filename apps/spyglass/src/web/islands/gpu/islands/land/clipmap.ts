/**
 * The terrain mesh: a flat geometry clipmap over the maps' texel grid.
 *
 * Level 0 is a square of `CLIP_CELLS` quads a side, `stride` texels each;
 * level `n` is a ring of the same count of quads at `stride · 2ⁿ`, whose
 * hole (its middle half) is exactly level `n − 1`. The levels are centred
 * under the eye, where perspective makes the ground nearest, so a cell
 * keeps about `CELL_PIXELS` on screen at every depth: each doubling of
 * distance from the eye is one level out.
 *
 * Two index buffers draw it: the full square once (level 0), and the ring
 * instanced once per further level, the level read from the instance index
 * (terrain.wgsl). Both index a local `(CLIP_CELLS + 1)²` vertex grid and
 * then one centre a cell; the vertex shader turns a local vertex and a
 * level into a texel, and splits each cell along the ground's contour.
 *
 * Level 0's corner snaps to the coarsest level's stride, so every level's
 * vertices sit on a fixed lattice of its own stride: panning slides the
 * mesh across the heights without them crawling.
 *
 * Close in, the stride goes below a texel, down to `1 / SUBTEXELS`: the
 * vertices rebuild the land's profile between texels (terrain.wgsl), so a
 * cliff steeper than a texel rises smoothly instead of in teeth.
 */
import { type MapFrame, sideOf } from "../maps/map-uniforms";

/** Lattice steps a texel: the finest stride is one of them (terrain.wgsl `SUBTEXELS`). */
export const SUBTEXELS = 4;
/** Quads a side of every level: a multiple of 4, so a ring's hole is whole. */
export const CLIP_CELLS = 512;
/** About how wide a level-0 cell is on screen, in pixels. */
const CELL_PIXELS = 4;
/**
 * The most levels drawn. Each level's corner is a multiple of its stride
 * only while `2^level` divides `CLIP_CELLS / 2`, so this stays at or under
 * `log2(CLIP_CELLS / 2)`.
 */
export const MAX_LEVELS = 8;
/**
 * Level 0's stride holds while the wanted one stays within this factor of
 * the half-octave either side, so a zoom resting near a doubling doesn't
 * swap meshes back and forth.
 */
const STRIDE_SLACK = 1.3;
/**
 * Lattice steps past the seabed map's edge the levels must reach (the
 * grid's, without one), so the ground runs on to it. Beyond the mesh, the
 * water composite lays its open floor at the open depth to the horizon,
 * which the seabed map eases onto across its outer band (seabed.wgsl,
 * map-uniforms.ts `openFloorDepth`).
 */
const EDGE_STEPS = 2;

/** The `Clip` uniform (terrain.wgsl): where the levels lie this frame. */
export interface ClipLayout {
  /** Levels drawn: level 0 and `levels − 1` rings. */
  readonly levels: number;
  /** Level 0's corner, in texels: texel `(i, j)`'s centre is `(i, j)`. */
  readonly origin: readonly [number, number];
  /** Level 0's cell, in texels; a power of two, at least `1 / SUBTEXELS`. */
  readonly stride: number;
}

/** Level `level`'s corner: each level is centred on the one inside it. */
export function levelCorner(clip: ClipLayout, level: number): [number, number] {
  const back = (CLIP_CELLS / 2) * clip.stride * (2 ** level - 1);
  return [clip.origin[0] - back, clip.origin[1] - back];
}

/** The power-of-two stride for a wanted one, held near the last. */
export function strideFor(wanted: number, previous?: number): number {
  const clamped = Math.max(wanted, 1 / SUBTEXELS);
  if (
    previous !== undefined &&
    clamped >= previous / (Math.SQRT2 * STRIDE_SLACK) &&
    clamped <= previous * Math.SQRT2 * STRIDE_SLACK
  ) {
    return previous;
  }
  return 2 ** Math.max(-Math.log2(SUBTEXELS), Math.round(Math.log2(clamped)));
}

/** The texels, low and high on both axes, the levels must reach. */
interface Reach {
  readonly high: readonly [number, number];
  readonly low: readonly [number, number];
}

const covers = (clip: ClipLayout, reach: Reach) => {
  const level = clip.levels - 1;
  const [x, y] = levelCorner(clip, level);
  const span = CLIP_CELLS * clip.stride * 2 ** level;
  const beyond = EDGE_STEPS * clip.stride * 2 ** level;
  const spans = (at: number, low: number, high: number) =>
    at <= low - beyond && at + span >= high + beyond;
  return (
    spans(x, reach.low[0], reach.high[0]) &&
    spans(y, reach.low[1], reach.high[1])
  );
};

/** The grid's texels, or the seabed map's square in them. */
function reachOf(frame: MapFrame, seabed: MapFrame | undefined): Reach {
  const last = frame.resolution - 1;
  if (!seabed) {
    return { high: [last, last], low: [0, 0] };
  }
  const across = sideOf(seabed) / frame.texel;
  const texelOf = (at: number, origin: number) =>
    (at - origin) / frame.texel - 0.5;
  const lowX = texelOf(seabed.origin[0], frame.origin[0]);
  const lowY = texelOf(seabed.origin[1], frame.origin[1]);
  return {
    high: [Math.max(lowX + across, last), Math.max(lowY + across, last)],
    low: [Math.min(lowX, 0), Math.min(lowY, 0)],
  };
}

/**
 * Where the levels lie for an eye at `eye` (world space) and a pixel
 * `pixel` world units wide at one unit of distance (`2 tan(fov / 2) /
 * height`). `previous` is the last frame's stride. The levels reach past
 * the grid to the seabed map's square, `seabed`, as far as `MAX_LEVELS`
 * take them.
 */
export function clipLayout(
  eye: readonly [number, number, number],
  pixel: number,
  frame: MapFrame,
  previous?: number,
  seabed?: MapFrame
): ClipLayout {
  const reach = reachOf(frame, seabed);
  const side = sideOf(frame);
  // The nearest ground is under the eye; past the grid, its nearest edge.
  const under = [
    Math.min(side, Math.max(0, eye[0] - frame.origin[0])) / frame.texel - 0.5,
    Math.min(side, Math.max(0, eye[2] - frame.origin[1])) / frame.texel - 0.5,
  ] as const;
  const height = Math.max(Math.abs(eye[1]), frame.texel);
  const stride = strideFor(
    (CELL_PIXELS * pixel * height) / frame.texel,
    previous
  );
  const span = CLIP_CELLS * stride;
  let clip: ClipLayout = { levels: 1, origin: [0, 0], stride };
  for (let levels = 1; levels <= MAX_LEVELS; levels += 1) {
    const snap = stride * 2 ** (levels - 1);
    clip = {
      levels,
      origin: [
        Math.round((under[0] - span / 2) / snap) * snap,
        Math.round((under[1] - span / 2) / snap) * snap,
      ],
      stride,
    };
    if (covers(clip, reach)) {
      return clip;
    }
  }
  return clip;
}

/** Local vertex `(x, y)` of a level's `(CLIP_CELLS + 1)²` grid. */
const vertexId = (x: number, y: number) => y * (CLIP_CELLS + 1) + x;
/** Cell `(x, y)`'s centre: after the corners, one a cell. */
const centreId = (x: number, y: number) =>
  (CLIP_CELLS + 1) ** 2 + y * CLIP_CELLS + x;

/**
 * A level's triangles, as a triangle list: four fanned round each cell's
 * centre, which stands on the diagonal that follows the ground
 * (terrain.wgsl), over the full square or a ring with its middle half
 * left out.
 */
export function levelIndices(ring: boolean): Uint32Array {
  const quarter = CLIP_CELLS / 4;
  const inHole = (x: number, y: number) =>
    ring &&
    x >= quarter &&
    x < CLIP_CELLS - quarter &&
    y >= quarter &&
    y < CLIP_CELLS - quarter;
  const cells = ring ? (CLIP_CELLS ** 2 * 3) / 4 : CLIP_CELLS ** 2;
  const indices = new Uint32Array(cells * 12);
  let at = 0;
  for (let y = 0; y < CLIP_CELLS; y += 1) {
    for (let x = 0; x < CLIP_CELLS; x += 1) {
      if (inHole(x, y)) {
        continue;
      }
      const a = vertexId(x, y);
      const b = vertexId(x + 1, y);
      const c = vertexId(x, y + 1);
      const d = vertexId(x + 1, y + 1);
      const e = centreId(x, y);
      indices.set([a, c, e, c, d, e, d, b, e, b, a, e], at);
      at += 12;
    }
  }
  return indices;
}
