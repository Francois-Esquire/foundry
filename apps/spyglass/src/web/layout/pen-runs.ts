import { unit } from "./geography";

export const penWeights = [0.7, 0.9, 1.1, 1.35];
const penKnot = 7;

/**
 * Pen pressure along one ring, seeded by `seed` and arc length so it is
 * identical on every repaint. Runs are appended to one bucket per weight; where
 * pressure falls below `lift` the pen leaves the paper and the line breaks.
 */
export function penRuns(
  ring: readonly (readonly [number, number])[],
  seed: string,
  buckets: number[][][],
  lift = 0
) {
  const knot = (k: number) => unit(`${seed}:${k}`);
  let travelled = 0;
  let current: number[] | undefined;
  let bucket = -1;
  for (let i = 1; i < ring.length; i += 1) {
    const a = ring[i - 1];
    const b = ring[i];
    if (!(a && b)) {
      continue;
    }
    const k = Math.floor(travelled / penKnot);
    const t = travelled / penKnot - k;
    const pressure = knot(k) + (knot(k + 1) - knot(k)) * t * t * (3 - 2 * t);
    travelled += Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (pressure < lift) {
      current = undefined;
      bucket = -1;
      continue;
    }
    const next = Math.min(
      penWeights.length - 1,
      Math.floor(((pressure - lift) / (1 - lift)) * penWeights.length)
    );
    if (next !== bucket || !current) {
      current = [a[0], a[1]];
      buckets[next]?.push(current);
      bucket = next;
    }
    current.push(b[0], b[1]);
  }
}
