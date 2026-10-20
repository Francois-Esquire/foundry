import {
  defaultHullSettings,
  type EmanationField,
  type HullRing,
  type HullSettings,
  ringOffset,
} from "./archipelago-hull";
import { gradientGrid, sampleGrid } from "./geology";

/**
 * Ring waves: swells on the open sea that start on one of the outer hull's
 * rings and travel inward to the next, building, folding and breaking on
 * the way. Each wave is a short arc of its ring, chosen once from the
 * ring's geometry; the scene animates it along precomputed paths, so the
 * CPU does no work per frame.
 */

type Point = readonly [number, number];

/**
 * The waves' tunables. The geometry (`rings`, `spacing`, `length`,
 * `samples`, `seed`, `jitter`) is chosen once on the CPU; `band`, `bow`,
 * `life`, `look` and `motion` are uniforms the scene can change live.
 */
export const defaultRingWaveSettings = {
  /**
   * The band of water a wave pushes, either side of its crest: `gaps` of
   * the ring gap it crosses, in map units, and never under `minPixels` on
   * screen. It narrows by `narrow` as the swell builds and steepens, and
   * widens by `widen` as it spreads into whitewater. It is held to `ofArc`
   * of the shown arc's half length, so a wave never reads wider than long.
   */
  band: { gaps: 0.15, minPixels: 3, narrow: 0.3, ofArc: 0.17, widen: 1 },
  /**
   * How far the crest bows forward, its ends lagging its apex: at most
   * `gaps` of the ring gap and `aspect` of the shown arc's half length, so
   * it stays a soft crescent and never a sharp V. The bow grows over the
   * crossing as `ringWaveLife`'s `bow` does.
   */
  bow: { aspect: 0.26, gaps: 0.4 },
  /**
   * The weight, 0 to 1, of seeded noise against the ring's curvature when
   * a site is chosen in each stretch of ring: 0 takes the sharpest headland
   * alone, 1 any point at random.
   */
  jitter: 0.35,
  /**
   * The crest's arc along its ring: `gaps` of the ring gap it crosses,
   * held between `min` and `max` map units.
   */
  length: { gaps: 2, max: 420, min: 80 },
  /**
   * A wave's life over its crossing, as shares of it, in order: it fades
   * in by `rise`; it builds, and the light through its face peaks, at
   * `build`; its lip pitches into a bright line at `fold`; it is all
   * whitewater at `crash`, and is gone on the inner ring. The fold starts
   * at the apex and peels to the ends `peel` of a crossing later.
   */
  life: { build: 0.46, crash: 0.78, fold: 0.62, peel: 0.12, rise: 0.12 },
  /**
   * The waves' ink. `swell` is the lifted water's colour and
   * `swellStrength` its peak opacity; `trough` the darkening behind it;
   * `glow` the light through the steepening face, added to the water, at
   * `glowStrength`; `foam` the lip's and the whitewater's colour, the lip
   * a line `lipPixels` wide at `lipStrength` and the foam at
   * `foamStrength`. `translucency` is the share of the lifted water the
   * glow turns to light. `strength` scales the lot. A wave fades in as the
   * gap it crosses opens on screen from `fade.from` to `fade.to` pixels, so
   * the inner rings' waves rest at the overview, and its visible arc is
   * held to `maxPixels` on screen.
   */
  look: {
    fade: { from: 60, to: 200 },
    foam: "#f2fbfa",
    foamStrength: 0.6,
    glow: "#4fe8d6",
    glowStrength: 0.5,
    lipPixels: 1.4,
    lipStrength: 0.75,
    maxPixels: 320,
    strength: 0.9,
    swell: "#c9eef0",
    swellStrength: 0.15,
    translucency: 0.7,
    trough: 0.3,
  },
  /**
   * How the waves move: `crossing` seconds from one ring to the next at the
   * mean tempo, then a rest of `rest` crossings unseen before the wave
   * starts again from its outer ring. Each wave's tempo varies by up to
   * `variance` either side of the mean.
   */
  motion: { crossing: 22, rest: 0.5, variance: 0.18 },
  /** The outer rings waves start from, inclusive; each crosses to the ring inside it. */
  rings: { from: 1, to: 10 },
  /** Points along each crest. */
  samples: 17,
  /** The seed every choice and stagger follows. */
  seed: 0x5e_ed_5a,
  /** Ring gaps of arc length between neighbouring sites on one ring, on average. */
  spacing: 4,
};
export type RingWaveSettings = typeof defaultRingWaveSettings;

/** One wave: an arc of ring `ring` and, for each of its points, the point it reaches on the ring inside. */
export interface RingWave {
  /** Each start point's place on the ring inside, down the ring coordinate's steepest descent. */
  end: readonly Point[];
  /** Map units between the wave's ring and the next inward: the distance it crosses. */
  gap: number;
  /** Map units of arc the crest spans along its ring. */
  length: number;
  /** Its share of the cycle, 0 to 1, by which it is staggered from the others. */
  offset: number;
  /** The index of the ring it starts on; it ends on `ring - 1`. */
  ring: number;
  /** The site the arc is centred on, in map units. */
  site: Point;
  /** The crest's points as it starts, on its ring, in order along it. */
  start: readonly Point[];
  /** Its pace against the mean, near 1. */
  tempo: number;
}

/** A deterministic 32-bit hash of integers, as a share from 0 up to 1. */
function hashShare(...values: number[]): number {
  let h = 2_166_136_261;
  for (const value of values) {
    // biome-ignore lint/suspicious/noBitwiseOperators: A deterministic hash seeds the waves' choices.
    h = Math.imul(h ^ (value | 0), 16_777_619);
    // biome-ignore lint/suspicious/noBitwiseOperators: Mixing the hash's bits.
    h ^= h >>> 15;
  }
  // A final avalanche, so neighbouring waves, whose inputs differ in their
  // low bits alone, get unrelated staggers and tempos rather than near
  // equal ones that pulse together.
  // biome-ignore lint/suspicious/noBitwiseOperators: Mixing the hash's bits.
  h = Math.imul(h ^ (h >>> 16), 0x85_eb_ca_6b);
  // biome-ignore lint/suspicious/noBitwiseOperators: Mixing the hash's bits.
  h = Math.imul(h ^ (h >>> 13), 0xc2_b2_ae_35);
  // biome-ignore lint/suspicious/noBitwiseOperators: Mixing the hash's bits.
  h ^= h >>> 16;
  // biome-ignore lint/suspicious/noBitwiseOperators: Unsigned for the share.
  return (h >>> 0) / 4_294_967_296;
}

/** A polyline resampled every `step` map units of arc, with its arc length. */
interface Resampled {
  closed: boolean;
  length: number;
  points: Point[];
  step: number;
}

function resample(ring: HullRing, step: number): Resampled {
  const source = ring.closed
    ? [...ring.points, ring.points[0] ?? [0, 0]]
    : [...ring.points];
  let length = 0;
  for (let i = 1; i < source.length; i += 1) {
    const a = source[i - 1] ?? [0, 0];
    const b = source[i] ?? [0, 0];
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const count = Math.max(2, Math.round(length / step));
  const spacing = length / count;
  const points: Point[] = [];
  let segment = 1;
  let walked = 0;
  for (let k = 0; k <= count; k += 1) {
    if (ring.closed && k === count) {
      break;
    }
    const target = k * spacing;
    let a = source[segment - 1] ?? [0, 0];
    let b = source[segment] ?? a;
    let span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (walked + span < target && segment < source.length - 1) {
      walked += span;
      segment += 1;
      a = b;
      b = source[segment] ?? a;
      span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const t = span > 0 ? Math.min(1, (target - walked) / span) : 0;
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return { closed: ring.closed, length, points, step: spacing };
}

/** The resampled point at arc position `s`, wrapping round a closed ring and clamped on an open one. */
function pointAt(line: Resampled, s: number): Point {
  const count = line.points.length;
  const at = s / line.step;
  const base = Math.floor(at);
  const t = at - base;
  const index = (i: number) =>
    line.closed
      ? ((i % count) + count) % count
      : Math.min(count - 1, Math.max(0, i));
  const a = line.points[index(base)];
  const b = line.points[index(base + 1)];
  if (!(a && b)) {
    return line.points[0] ?? [0, 0];
  }
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * The signed turning at each resampled point over `window` points either
 * side: positive where the ring bulges outward, a headland, since rings
 * are wound with positive area and so turn positively where convex.
 */
function turning(line: Resampled, window: number): Float32Array {
  const count = line.points.length;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const before = line.closed
      ? (i - window + count) % count
      : Math.max(0, i - window);
    const after = line.closed
      ? (i + window) % count
      : Math.min(count - 1, i + window);
    const p = line.points[i] ?? [0, 0];
    const a = line.points[before] ?? p;
    const b = line.points[after] ?? p;
    const ux = p[0] - a[0];
    const uy = p[1] - a[1];
    const vx = b[0] - p[0];
    const vy = b[1] - p[1];
    out[i] = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  }
  return out;
}

/** Map units each descent step takes, as a share of the field's cell. */
const descentStep = 0.5;
/** The longest a descent may wander, in ring gaps, before its site is refused. */
const descentReach = 1.7;
/**
 * How much faster than its arc a crest's far end may spread before the
 * site is refused: a crest that fans out this much is crossing a crease
 * where two hulls' fields meet.
 */
const spreadLimit = 3;

/**
 * Where a point on ring `from` reaches ring `from - 1` going down the ring
 * coordinate's steepest descent, or null if it wanders further than
 * `reach` map units or loses the slope.
 */
function descend(
  field: EmanationField,
  point: Point,
  to: number,
  reach: number
): Point | null {
  const step = field.cell * descentStep;
  let [x, y] = point;
  let previous = sampleGrid(field, field.ring, x, y);
  let walked = 0;
  while (walked <= reach) {
    if (previous <= to) {
      return [x, y];
    }
    const [gx, gy] = gradientGrid(field, field.ring, x, y);
    const slope = Math.hypot(gx, gy);
    if (!(slope > 1e-9)) {
      return null;
    }
    const nx = x - (gx / slope) * step;
    const ny = y - (gy / slope) * step;
    const next = sampleGrid(field, field.ring, nx, ny);
    walked += step;
    if (next <= to) {
      const t = previous > next ? (previous - to) / (previous - next) : 1;
      return [x + (nx - x) * t, y + (ny - y) * t];
    }
    if (next >= previous) {
      return null;
    }
    x = nx;
    y = ny;
    previous = next;
  }
  return null;
}

/** The crest's end points, or null if any fails to descend or the crest fans across a crease. */
function crestEnds(
  field: EmanationField,
  start: readonly Point[],
  ring: number,
  gap: number
): Point[] | null {
  const end: Point[] = [];
  for (const point of start) {
    const reached = descend(field, point, ring - 1, gap * descentReach);
    if (!reached) {
      return null;
    }
    end.push(reached);
  }
  for (let j = 1; j < start.length; j += 1) {
    const s0 = start[j - 1] ?? [0, 0];
    const s1 = start[j] ?? [0, 0];
    const e0 = end[j - 1] ?? [0, 0];
    const e1 = end[j] ?? [0, 0];
    const sx = s1[0] - s0[0];
    const sy = s1[1] - s0[1];
    const ex = e1[0] - e0[0];
    const ey = e1[1] - e0[1];
    const folded = sx * ex + sy * ey <= 0;
    const fanned = Math.hypot(ex, ey) > spreadLimit * Math.hypot(sx, sy);
    if (folded || fanned) {
      return null;
    }
  }
  return end;
}

/** Shares of a stretch at either end where no site is taken, so neighbours keep apart. */
const stretchMargin = 0.2;

/**
 * The sites on one ring piece, as arc positions: the ring is cut into
 * stretches of about `spacing` gaps from a seeded origin, and each takes
 * its most convex point, weighed against seeded noise by `jitter`. An
 * open piece keeps its sites a crest's half length from its ends.
 */
function siteArcs(
  line: Resampled,
  options: { half: number; piece: number; slot: number },
  settings: RingWaveSettings
): number[] {
  const window = Math.max(1, Math.round(options.half / line.step));
  const bends = turning(line, window);
  let sharpest = 1e-6;
  for (const bend of bends) {
    sharpest = Math.max(sharpest, bend);
  }
  const usableFrom = line.closed ? 0 : options.half + line.step;
  const usableTo = line.closed
    ? line.length
    : line.length - options.half - line.step;
  const usable = usableTo - usableFrom;
  if (usable <= 0) {
    return [];
  }
  const count = Math.max(1, Math.round(usable / options.slot));
  const slot = usable / count;
  const origin = line.closed
    ? hashShare(settings.seed, options.piece, 1) * slot
    : 0;
  const arcs: number[] = [];
  for (let k = 0; k < count; k += 1) {
    const from = usableFrom + origin + (k + stretchMargin) * slot;
    const to = usableFrom + origin + (k + 1 - stretchMargin) * slot;
    let best = from;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let s = from; s <= to; s += line.step) {
      const index = Math.round(s / line.step) % line.points.length;
      const convex = Math.max(0, bends[index] ?? 0) / sharpest;
      const noise = hashShare(settings.seed, options.piece, index, 2);
      const score = convex * (1 - settings.jitter) + noise * settings.jitter;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    arcs.push(line.closed ? best % line.length : best);
  }
  return arcs;
}

/**
 * The waves over the emanation `field`, from its traced `rings`, as
 * `hullRings` gives them: on each ring piece whose index lies in
 * `settings.rings`, sites spread about `spacing` ring gaps apart at the
 * ring's headlands, each the centre of a crest `length` long whose points
 * are carried down the ring coordinate to the ring inside. Sites whose
 * crests would cross a crease between two hulls' fields are left out. The
 * same field and settings give the same waves.
 */
export function ringWaves(
  field: EmanationField,
  rings: readonly HullRing[],
  settings: RingWaveSettings = defaultRingWaveSettings,
  hull: HullSettings["rings"] = defaultHullSettings.rings
): RingWave[] {
  const waves: RingWave[] = [];
  const samples = Math.max(2, Math.round(settings.samples));
  for (const [piece, ring] of rings.entries()) {
    const inRange =
      ring.index >= Math.max(1, settings.rings.from) &&
      ring.index <= settings.rings.to;
    if (!inRange) {
      continue;
    }
    const gap = ringOffset(ring.index, hull) - ringOffset(ring.index - 1, hull);
    const length = Math.min(
      settings.length.max,
      Math.max(settings.length.min, settings.length.gaps * gap)
    );
    const half = length / 2;
    const line = resample(ring, field.cell * descentStep);
    const arcs = siteArcs(
      line,
      { half, piece, slot: settings.spacing * gap },
      settings
    );
    for (const [order, arc] of arcs.entries()) {
      const start: Point[] = [];
      for (let j = 0; j < samples; j += 1) {
        start.push(pointAt(line, arc + half * ((2 * j) / (samples - 1) - 1)));
      }
      const end = crestEnds(field, start, ring.index, gap);
      if (!end) {
        continue;
      }
      const { variance } = settings.motion;
      waves.push({
        end,
        gap,
        length,
        offset: hashShare(settings.seed, piece, order, 3),
        ring: ring.index,
        site: pointAt(line, arc),
        start,
        tempo:
          1 + variance * (2 * hashShare(settings.seed, piece, order, 4) - 1),
      });
    }
  }
  return waves;
}

/**
 * A wave's place in its crossing at `time` seconds: 0 on its outer ring,
 * 1 on the inner, and over 1 while it rests unseen, up to `1 + rest`. The
 * scene's shader computes the same.
 */
export function ringWavePhase(
  time: number,
  wave: Pick<RingWave, "offset" | "tempo">,
  motion: RingWaveSettings["motion"] = defaultRingWaveSettings.motion
): number {
  const span = 1 + Math.max(0, motion.rest);
  const cycles = (time * wave.tempo) / (Math.max(1e-3, motion.crossing) * span);
  const share = cycles + wave.offset;
  return (share - Math.floor(share)) * span;
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** A wave's life at one phase: each channel 0 to 1. */
export interface RingWaveLife {
  /** How far the crest has bowed, of its most; it only grows. */
  bow: number;
  /** How far the swell has built and steepened; it only grows. */
  build: number;
  /** The whitewater: it spreads in from the fold, is fullest at `crash`, and fades out on the inner ring. */
  foam: number;
  /** The light through the steepening face: it peaks at `build`, before the fold, and collapses by `crash`. */
  glow: number;
  /** The pitching lip's bright line: brightest at `fold`, gone into foam by `crash`. */
  lip: number;
  /** The whole wave's fade in and out. */
  opacity: number;
  /** How far the lip has pitched forward, from `build` to `crash`; it only grows. */
  pitch: number;
  /** How far the whitewater has spread forward; it only grows. */
  spread: number;
  /** The lifted band of water and its trough: built by `build`, collapsing into foam by `crash`. */
  swell: number;
}

const still: RingWaveLife = {
  bow: 0,
  build: 0,
  foam: 0,
  glow: 0,
  lip: 0,
  opacity: 0,
  pitch: 0,
  spread: 0,
  swell: 0,
};

/**
 * The wave's life at `phase`: it swells and bows, glows as it builds,
 * folds into a bright lip, and crashes into whitewater that fades out on
 * the inner ring. Every channel is 0 outside the crossing, while the wave
 * rests. The scene's shader computes the same.
 */
export function ringWaveLife(
  phase: number,
  life: RingWaveSettings["life"] = defaultRingWaveSettings.life
): RingWaveLife {
  if (!(phase >= 0 && phase < 1)) {
    return still;
  }
  const fade = 1 - smoothstep(life.crash, 1, phase);
  const build = smoothstep(0, life.build, phase);
  const pitched = smoothstep(life.fold, life.crash, phase);
  return {
    bow: smoothstep(0, life.crash, phase),
    build,
    foam: pitched * fade,
    glow:
      smoothstep(life.rise, life.build, phase) *
      (1 - smoothstep(life.build, life.crash, phase)),
    lip: smoothstep(life.build, life.fold, phase) * (1 - pitched),
    opacity: smoothstep(0, life.rise, phase) * fade,
    pitch: smoothstep(life.build, life.crash, phase),
    spread: smoothstep(life.fold, 1, phase),
    swell: build * (1 - pitched),
  };
}

/**
 * The crest's bow at `along`, its place on the shown arc from -1 to 1:
 * 1 at the apex, falling smoothly to 0 at the ends. Each point lags the
 * apex by `1 - bow` of the wave's bow distance. The scene's shader
 * computes the same.
 */
export function ringWaveBow(along: number): number {
  const a = Math.min(1, Math.abs(along));
  return 1 - a * a;
}

/**
 * The phase a point of the crest at `along`, on the shown arc from -1 to
 * 1, lives at: the apex at the wave's own phase and the ends up to `peel`
 * behind, so the fold and the crash peel out from the apex. The scene's
 * shader computes the same.
 */
export function ringWaveLocalPhase(
  phase: number,
  along: number,
  peel: number = defaultRingWaveSettings.life.peel
): number {
  return phase - peel * (1 - ringWaveBow(along));
}
