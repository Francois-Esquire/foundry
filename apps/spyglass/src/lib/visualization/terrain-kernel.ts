/**
 * The arithmetic a terrain kernel is written over, so one function drives
 * both the CPU and the GPU: plain numbers here, shader nodes in the screen
 * terrain's TSL backend. A kernel never reads `Math` or writes a branch on
 * its values; it asks the backend, so each backend computes the same
 * formula, op for op, in its own precision. `F` is a float, `U` an
 * unsigned 32-bit integer for hashing and `B` a boolean.
 *
 * Every binary op takes a plain number for either operand, which a backend
 * lifts to its own kind, so a kernel reads close to the formula it mirrors.
 */
export interface KernelMath<F, U, B> {
  abs(value: F): F;
  add(a: F | number, b: F | number): F;
  and(a: B, b: B): B;
  /** Two-argument arctangent: the bearing of (x, y), −π to π. */
  atan2(y: F | number, x: F | number): F;
  /**
   * The value of the case a float index picks, 0 for the first: on the
   * CPU only that case is computed, on the GPU a branch per case, so a
   * kernel can switch on data, such as an island's formation.
   */
  branch(index: F, cases: readonly (() => F)[]): F;
  cos(value: F): F;
  div(a: F | number, b: F | number): F;
  float(value: number): F;
  floor(value: F): F;
  /** The 32 bits of the integer floor of a float: an int reinterpreted as unsigned, as `Math.floor(x) | 0` gives in JS. */
  floorBits(value: F): U;
  /** A small unsigned integer as a float, exactly. */
  fromUint(value: U): F;
  /** Euclidean length of (a, b). */
  hypot(a: F | number, b: F | number): F;
  /** Unsigned multiply, keeping the low 32 bits. */
  imul(a: U, b: U | number): U;
  /**
   * The value held where it is computed: identity on the CPU, a shader
   * variable on the GPU, so a value computed before a `branch` and read
   * inside it is declared outside it.
   */
  keep(value: F): F;
  lt(a: F | number, b: F | number): B;
  max(a: F | number, b: F | number): F;
  min(a: F | number, b: F | number): F;
  mul(a: F | number, b: F | number): F;
  pow(base: F | number, exponent: F | number): F;
  select(condition: B, whenTrue: F | number, whenFalse: F | number): F;
  shr(value: U, bits: number): U;
  sin(value: F): F;
  sqrt(value: F): F;
  sub(a: F | number, b: F | number): F;
  uint(value: number): U;
  /** The bitwise and of an unsigned integer with a mask. */
  uintAnd(value: U, mask: number): U;
  /** An unsigned integer from its high and low 16 bits, each held exactly in a float. */
  uintFromHalves(high: F | number, low: F | number): U;
  /** An unsigned integer over 2³²: 0 to just under 1. */
  uintUnit(value: U): F;
  uintXor(a: U, b: U): U;
}

/** Plain numbers: the kernel's CPU backend, in double precision as the CPU modules compute. */
export const numberMath: KernelMath<number, number, boolean> = {
  abs: Math.abs,
  add: (a, b) => a + b,
  and: (a, b) => a && b,
  atan2: Math.atan2,
  branch: (index, cases) => {
    const chosen = cases[Math.round(index)];
    if (!chosen) {
      throw new Error(`No kernel case ${index} of ${cases.length}.`);
    }
    return chosen();
  },
  cos: Math.cos,
  div: (a, b) => a / b,
  float: (value) => value,
  floor: Math.floor,
  // biome-ignore lint/suspicious/noBitwiseOperators: The kernel mirrors the integer hash a shader computes.
  floorBits: (value) => (Math.floor(value) | 0) >>> 0,
  fromUint: (value) => value,
  hypot: Math.hypot,
  // biome-ignore lint/suspicious/noBitwiseOperators: Unsigned 32-bit multiply, as the shader's u32.
  imul: (a, b) => Math.imul(a, b) >>> 0,
  keep: (value) => value,
  lt: (a, b) => a < b,
  max: Math.max,
  min: Math.min,
  mul: (a, b) => a * b,
  pow: (base, exponent) => base ** exponent,
  select: (condition, whenTrue, whenFalse) =>
    condition ? whenTrue : whenFalse,
  // biome-ignore lint/suspicious/noBitwiseOperators: Logical shift of an unsigned 32-bit integer.
  shr: (value, bits) => value >>> bits,
  sin: Math.sin,
  sqrt: Math.sqrt,
  sub: (a, b) => a - b,
  // biome-ignore lint/suspicious/noBitwiseOperators: Seeds and hashes are unsigned 32-bit integers.
  uint: (value) => value >>> 0,
  // biome-ignore lint/suspicious/noBitwiseOperators: Masks an unsigned 32-bit integer, as the shader's.
  uintAnd: (value, mask) => (value & mask) >>> 0,
  uintFromHalves: (high, low) => (high * 65_536 + low) % 4_294_967_296,
  uintUnit: (value) => value / 4_294_967_296,
  // biome-ignore lint/suspicious/noBitwiseOperators: Integer hashing, as the shader's.
  uintXor: (a, b) => (a ^ b) >>> 0,
};

const f = Math.fround;

/**
 * Plain numbers rounded to single precision after every op: the GPU's
 * float arithmetic, near enough to estimate in a test how far a shader's
 * result may stray from the CPU's without a GPU. Transcendentals are
 * computed in double and rounded, which a GPU does no better than.
 */
export const float32Math: KernelMath<number, number, boolean> = {
  ...numberMath,
  abs: (value) => f(Math.abs(value)),
  add: (a, b) => f(f(a) + f(b)),
  atan2: (y, x) => f(Math.atan2(f(y), f(x))),
  cos: (value) => f(Math.cos(f(value))),
  div: (a, b) => f(f(a) / f(b)),
  float: (value) => f(value),
  floor: (value) => f(Math.floor(value)),
  fromUint: (value) => f(value),
  hypot: (a, b) => f(Math.sqrt(f(f(f(a) * f(a)) + f(f(b) * f(b))))),
  max: (a, b) => f(Math.max(a, b)),
  min: (a, b) => f(Math.min(a, b)),
  mul: (a, b) => f(f(a) * f(b)),
  pow: (base, exponent) => f(f(base) ** f(exponent)),
  select: (condition, whenTrue, whenFalse) =>
    f(condition ? whenTrue : whenFalse),
  sin: (value) => f(Math.sin(f(value))),
  sqrt: (value) => f(Math.sqrt(f(value))),
  sub: (a, b) => f(f(a) - f(b)),
  uintUnit: (value) => f(f(value) / 4_294_967_296),
};
