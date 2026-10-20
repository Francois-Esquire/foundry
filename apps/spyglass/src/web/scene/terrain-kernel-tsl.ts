import {
  abs,
  atan,
  cos,
  float,
  floor,
  If,
  int,
  max,
  min,
  pow,
  select,
  sin,
  sqrt,
  uint,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { KernelMath } from "../../lib/visualization/terrain-kernel";

/**
 * The terrain kernels' GPU backend: each op of `KernelMath` as the TSL node
 * that computes it, so a kernel written once for the CPU builds the same
 * formula into a shader. Integer hashing runs on unsigned 32-bit integers,
 * whose multiply wraps as `Math.imul` does; a lattice point's floor is
 * converted float to int to unsigned, which keeps a negative column's bits
 * on both WGSL and GLSL. `branch` emits an if-chain, so it must be called
 * inside a `Fn`.
 */
export type FloatNode = Node<"float">;
export type UintNode = Node<"uint">;
export type BoolNode = Node<"bool">;

const lift = (value: FloatNode | number): FloatNode =>
  typeof value === "number" ? float(value) : value;

export const nodeMath: KernelMath<FloatNode, UintNode, BoolNode> = {
  abs: (value) => abs(value),
  add: (a, b) => lift(a).add(b),
  and: (a, b) => a.and(b),
  atan2: (y, x) => atan(lift(y), lift(x)),
  branch: (index, cases) => {
    const result = float(0).toVar();
    const [first, ...rest] = cases;
    if (!first) {
      return result;
    }
    let chain = If(index.lessThan(0.5), () => {
      result.assign(first());
    });
    for (const [offset, each] of rest.entries()) {
      chain = chain.ElseIf(index.lessThan(offset + 1.5), () => {
        result.assign(each());
      });
    }
    return result;
  },
  cos: (value) => cos(value),
  div: (a, b) => lift(a).div(b),
  float: (value) => float(value),
  floor: (value) => floor(value),
  floorBits: (value) => uint(int(floor(value))),
  fromUint: (value) => float(value),
  hypot: (a, b) => {
    const x = lift(a);
    const y = lift(b);
    return sqrt(x.mul(x).add(y.mul(y)));
  },
  imul: (a, b) => a.mul(typeof b === "number" ? uint(b) : b),
  keep: (value) => value.toVar(),
  lt: (a, b) => lift(a).lessThan(b),
  max: (a, b) => max(lift(a), lift(b)),
  min: (a, b) => min(lift(a), lift(b)),
  mul: (a, b) => lift(a).mul(b),
  pow: (base, exponent) => pow(lift(base), lift(exponent)),
  select: (condition, whenTrue, whenFalse) =>
    select(condition, lift(whenTrue), lift(whenFalse)),
  shr: (value, bits) => value.shiftRight(uint(bits)),
  sin: (value) => sin(value),
  sqrt: (value) => sqrt(value),
  sub: (a, b) => lift(a).sub(b),
  uint: (value) => uint(value),
  uintAnd: (value, mask) => value.bitAnd(uint(mask)),
  uintFromHalves: (high, low) =>
    uint(lift(high))
      .shiftLeft(uint(16))
      .bitOr(uint(lift(low))),
  uintUnit: (value) => float(value).div(4_294_967_296),
  uintXor: (a, b) => a.bitXor(b),
};
