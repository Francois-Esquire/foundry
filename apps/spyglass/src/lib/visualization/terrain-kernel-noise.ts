import type { FractalSettings } from "./noise";
import type { KernelMath } from "./terrain-kernel";

/**
 * `noise.ts` as a terrain kernel: the same integer hash, gradient noise and
 * fBm, op for op, over any backend, so the GPU computes the values the CPU
 * modules do from the same integers. The constants are `noise.ts`'s own;
 * a parity test holds the two together.
 */

const hashColumn = 0x27_d4_eb_2d;
const hashRow = 0x16_56_67_b1;
const mixFirst = 0x85_eb_ca_6b;
const mixSecond = 0xc2_b2_ae_35;
const octaveSalt = 0x5e_ed;
const octaveRotation = { cos: 0.8, sin: 0.6 } as const;
const octaveShift = { x: 17.31, y: -31.79 } as const;

/** The kernel's noise over one backend. */
export function kernelNoise<F, U, B>(m: KernelMath<F, U, B>) {
  /** `latticeHash` with the lattice point already as its 32 bits. */
  const hashBits = (column: U, row: U, seed: U): U => {
    let h = m.uintXor(
      m.uintXor(seed, m.imul(column, hashColumn)),
      m.imul(row, hashRow)
    );
    h = m.imul(m.uintXor(h, m.shr(h, 15)), mixFirst);
    h = m.imul(m.uintXor(h, m.shr(h, 13)), mixSecond);
    return m.uintXor(h, m.shr(h, 16));
  };

  /** `latticeHash` of an integer lattice point given as constants. */
  const hashConstant = (column: number, row: number, seed: U): U =>
    hashBits(m.uint(column), m.uint(row), seed);

  /** The seed of one octave of a fractal sum. */
  const octaveSeed = (seed: U, octave: number): U =>
    hashConstant(octave, octaveSalt, seed);

  const fade = (t: F): F =>
    m.mul(m.mul(m.mul(t, t), t), m.add(m.mul(t, m.sub(m.mul(t, 6), 15)), 10));

  const mix = (a: F, b: F, t: F): F => m.add(a, m.mul(m.sub(b, a), t));

  /**
   * One corner's hashed unit gradient dotted with the offset to it. The
   * eight gradients are picked arithmetically from the hash's low three
   * bits: an axis for 0–3, a diagonal for 4–7, the sign from bit 0 and,
   * for a diagonal, bit 1.
   */
  const cornerDot = (column: U, row: U, dx: F, dy: F, seed: U): F => {
    const h = hashBits(column, row, seed);
    const bit = (shift: number) => m.fromUint(m.uintAnd(m.shr(h, shift), 1));
    const sign0 = m.sub(1, m.mul(2, bit(0)));
    const b1 = bit(1);
    const diagonal = m.lt(0.5, bit(2));
    const half = Math.SQRT1_2;
    // Axis: (±1, 0) for bit 1 clear, (0, ±1) for bit 1 set.
    const axisX = m.mul(sign0, m.sub(1, b1));
    const axisY = m.mul(sign0, b1);
    const diagonalX = m.mul(sign0, half);
    const diagonalY = m.mul(m.sub(1, m.mul(2, b1)), half);
    const gx = m.select(diagonal, diagonalX, axisX);
    const gy = m.select(diagonal, diagonalY, axisY);
    return m.add(m.mul(gx, dx), m.mul(gy, dy));
  };

  const clampSigned = (value: F): F => m.min(1, m.max(-1, value));

  /** `gradientNoise`: Perlin-style noise in [-1, 1]. */
  const gradient = (x: F, y: F, seed: U): F => {
    const fx = m.floor(x);
    const fy = m.floor(y);
    const column = m.floorBits(x);
    const row = m.floorBits(y);
    const column1 = m.floorBits(m.add(fx, 1));
    const row1 = m.floorBits(m.add(fy, 1));
    const dx = m.sub(x, fx);
    const dy = m.sub(y, fy);
    const s = fade(dx);
    const t = fade(dy);
    const north = mix(
      cornerDot(column, row, dx, dy, seed),
      cornerDot(column1, row, m.sub(dx, 1), dy, seed),
      s
    );
    const south = mix(
      cornerDot(column, row1, dx, m.sub(dy, 1), seed),
      cornerDot(column1, row1, m.sub(dx, 1), m.sub(dy, 1), seed),
      s
    );
    return clampSigned(m.mul(mix(north, south, t), Math.SQRT2));
  };

  /** `fbm`: octaves of gradient noise in [-1, 1], unrolled at build. */
  const fbm = (x: F, y: F, seed: U, settings: FractalSettings): F => {
    let px = x;
    let py = y;
    let amplitude = 1;
    let total = 0;
    let sum: F = m.float(0);
    const octaves = Math.max(1, Math.floor(settings.octaves));
    for (let octave = 0; octave < octaves; octave += 1) {
      sum = m.add(
        sum,
        m.mul(amplitude, gradient(px, py, octaveSeed(seed, octave)))
      );
      total += amplitude;
      amplitude *= settings.gain;
      const nx = m.add(
        m.mul(
          m.sub(m.mul(octaveRotation.cos, px), m.mul(octaveRotation.sin, py)),
          settings.lacunarity
        ),
        octaveShift.x
      );
      const ny = m.add(
        m.mul(
          m.add(m.mul(octaveRotation.sin, px), m.mul(octaveRotation.cos, py)),
          settings.lacunarity
        ),
        octaveShift.y
      );
      px = nx;
      py = ny;
    }
    return clampSigned(m.div(sum, total));
  };

  return { fbm, gradient, hashBits, octaveSeed };
}

export type KernelNoise<F, U> = ReturnType<typeof kernelNoise<F, U, unknown>>;
