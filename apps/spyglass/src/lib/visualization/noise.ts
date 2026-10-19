import { unit } from "./geography";

/**
 * Deterministic, seeded 2D noise for terrain detail. Every function is a
 * pure function of its coordinates and a 32-bit integer seed: lattice
 * values come from an integer hash, never from `Math.random` or a
 * permutation table, so a shader can compute the same values from the same
 * integers. Coordinates are in lattice units; a caller divides map units by
 * a wavelength first. Signed noise lies in [-1, 1] and ridged noise in
 * [0, 1].
 */

/** The octaves of a fractal sum: how many, how much finer each is, and how much weaker. */
export interface FractalSettings {
  /** Amplitude of each octave relative to the one before it. */
  gain: number;
  /** Frequency of each octave relative to the one before it. */
  lacunarity: number;
  octaves: number;
}

export const defaultFractalSettings: FractalSettings = {
  gain: 0.5,
  lacunarity: 2,
  octaves: 4,
};

/** A displacement of the domain by fBm: how far it moves a point and at what scale. */
export interface WarpSettings extends FractalSettings {
  /** The largest displacement, in the caller's units. */
  amplitude: number;
  /** Lattice cells per caller unit of the displacing noise. */
  frequency: number;
}

export const defaultWarpSettings: WarpSettings = {
  amplitude: 1,
  frequency: 1,
  gain: 0.5,
  lacunarity: 2,
  octaves: 2,
};

const uint32Range = 4_294_967_296;

/**
 * Each octave is rotated and shifted from the one before it, so the
 * octaves' lattices never align and no point is a zero of every octave.
 */
const octaveRotation = { cos: 0.8, sin: 0.6 } as const;
const octaveShift = { x: 17.31, y: -31.79 } as const;

/** A second, independent fBm for the warp's y displacement starts here. */
const warpOffset = { x: 5.2, y: 1.3 } as const;

/** 2D gradient noise with unit gradients peaks at √½; this scales it to [-1, 1]. */
const gradientScale = Math.SQRT2;

/** Eight unit gradients: the axes and the diagonals. */
const gradientX = [
  1,
  -1,
  0,
  0,
  Math.SQRT1_2,
  -Math.SQRT1_2,
  Math.SQRT1_2,
  -Math.SQRT1_2,
] as const;
const gradientY = [
  0,
  0,
  1,
  -1,
  Math.SQRT1_2,
  Math.SQRT1_2,
  -Math.SQRT1_2,
  -Math.SQRT1_2,
] as const;

/** A 32-bit integer seed from a string, through the map's own string hash. */
export function noiseSeed(id: string): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: Seeds are unsigned 32-bit integers so a shader can mirror them.
  return Math.floor(unit(id) * uint32Range) >>> 0;
}

/** An unsigned 32-bit hash of a lattice point and a seed: an integer finaliser, no table. */
export function latticeHash(column: number, row: number, seed: number): number {
  // biome-ignore-start lint/suspicious/noBitwiseOperators: Integer hashing keeps lattice values deterministic and portable to a shader.
  let h =
    (seed ^
      Math.imul(column | 0, 0x27_d4_eb_2d) ^
      Math.imul(row | 0, 0x16_56_67_b1)) >>>
    0;
  h = Math.imul(h ^ (h >>> 15), 0x85_eb_ca_6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2_b2_ae_35);
  return (h ^ (h >>> 16)) >>> 0;
  // biome-ignore-end lint/suspicious/noBitwiseOperators: Integer hashing keeps lattice values deterministic and portable to a shader.
}

/** The seed of one octave of a fractal sum, derived from the sum's own seed. */
function octaveSeed(seed: number, octave: number): number {
  return latticeHash(octave, 0x5e_ed, seed);
}

/** Quintic fade: zero first and second derivatives at 0 and 1. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clampSigned(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/** Value noise in [-1, 1]: hashed lattice values, interpolated with a quintic fade. */
export function valueNoise(x: number, y: number, seed: number): number {
  const column = Math.floor(x);
  const row = Math.floor(y);
  const s = fade(x - column);
  const t = fade(y - row);
  const at = (c: number, r: number) =>
    (latticeHash(c, r, seed) / uint32Range) * 2 - 1;
  return mix(
    mix(at(column, row), at(column + 1, row), s),
    mix(at(column, row + 1), at(column + 1, row + 1), s),
    t
  );
}

/** One lattice corner's contribution: its hashed unit gradient dotted with the offset to it. */
function cornerDot(
  column: number,
  row: number,
  dx: number,
  dy: number,
  seed: number
): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: The low three bits of the hash choose one of eight gradients.
  const index = latticeHash(column, row, seed) & 7;
  return (gradientX[index] ?? 0) * dx + (gradientY[index] ?? 0) * dy;
}

/** Gradient (Perlin-style) noise in [-1, 1]: zero at every lattice point. */
export function gradientNoise(x: number, y: number, seed: number): number {
  const column = Math.floor(x);
  const row = Math.floor(y);
  const dx = x - column;
  const dy = y - row;
  const s = fade(dx);
  const t = fade(dy);
  const north = mix(
    cornerDot(column, row, dx, dy, seed),
    cornerDot(column + 1, row, dx - 1, dy, seed),
    s
  );
  const south = mix(
    cornerDot(column, row + 1, dx, dy - 1, seed),
    cornerDot(column + 1, row + 1, dx - 1, dy - 1, seed),
    s
  );
  return clampSigned(mix(north, south, t) * gradientScale);
}

/** Steps a point to the next octave's lattice: rotated, scaled by lacunarity, and shifted. */
function nextOctave(
  x: number,
  y: number,
  lacunarity: number
): [number, number] {
  return [
    (octaveRotation.cos * x - octaveRotation.sin * y) * lacunarity +
      octaveShift.x,
    (octaveRotation.sin * x + octaveRotation.cos * y) * lacunarity +
      octaveShift.y,
  ];
}

/** Fractal Brownian motion of gradient noise in [-1, 1], normalised by the octaves' total amplitude. */
export function fbm(
  x: number,
  y: number,
  seed: number,
  settings: FractalSettings = defaultFractalSettings
): number {
  let px = x;
  let py = y;
  let amplitude = 1;
  let sum = 0;
  let total = 0;
  const octaves = Math.max(1, Math.floor(settings.octaves));
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * gradientNoise(px, py, octaveSeed(seed, octave));
    total += amplitude;
    amplitude *= settings.gain;
    [px, py] = nextOctave(px, py, settings.lacunarity);
  }
  return clampSigned(sum / total);
}

/**
 * Ridged fBm in [0, 1]: each octave is `(1 - |noise|)²`, sharp crests where
 * the noise crosses zero, and each finer octave is weighted by the ridge
 * beneath it so detail gathers on the crests, as eroded relief does.
 */
export function ridgedFbm(
  x: number,
  y: number,
  seed: number,
  settings: FractalSettings = defaultFractalSettings
): number {
  let px = x;
  let py = y;
  let amplitude = 1;
  let weight = 1;
  let sum = 0;
  let total = 0;
  const octaves = Math.max(1, Math.floor(settings.octaves));
  for (let octave = 0; octave < octaves; octave += 1) {
    const ridge = 1 - Math.abs(gradientNoise(px, py, octaveSeed(seed, octave)));
    const crest = ridge * ridge * weight;
    sum += amplitude * crest;
    total += amplitude;
    weight = Math.min(1, Math.max(0, crest * 2));
    amplitude *= settings.gain;
    [px, py] = nextOctave(px, py, settings.lacunarity);
  }
  return Math.min(1, Math.max(0, sum / total));
}

/**
 * A point displaced by two independent fBm fields, at most `amplitude` in
 * each axis: features sampled at the warped point meander instead of
 * following the lattice.
 */
export function domainWarp(
  x: number,
  y: number,
  seed: number,
  settings: WarpSettings = defaultWarpSettings
): [number, number] {
  const u = x * settings.frequency;
  const v = y * settings.frequency;
  return [
    x + settings.amplitude * fbm(u, v, seed, settings),
    y +
      settings.amplitude *
        fbm(u + warpOffset.x, v + warpOffset.y, octaveSeed(seed, -1), settings),
  ];
}
