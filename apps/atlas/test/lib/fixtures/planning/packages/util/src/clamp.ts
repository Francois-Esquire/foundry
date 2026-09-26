import type { Range } from "./range";

export function clamp(n: number, r: Range): number {
  return Math.min(r.max, Math.max(r.min, n));
}

export function normalize(n: number): number {
  return clamp(n, { min: 0, max: 1 });
}
