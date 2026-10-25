import { elevationAtDepth } from "./geology";
import type { KernelMath } from "./terrain-kernel";

/**
 * The terrace pass of `world-terrain.ts` as a terrain kernel: one sea
 * cell's elevation stepped into treads and risers between the levels, from
 * its elevation before the pass and its slope. The CPU pass and the screen
 * terrain's bake both run it, so the plates the GPU draws at any zoom are
 * the plates the world grid holds at its cells.
 */
export interface KernelTerraceSettings {
  /** Nominal metres of the levels, any order. */
  levels: readonly number[];
  /** Map units of a span's width at which the steps are full; at half of it they are gone. */
  minTread: number;
  riser: { least: number; most: number; width: number };
  strength: number;
}

/**
 * The stepped elevation of one sea cell: unchanged outside the levels'
 * range or where the span across the slope is narrower than half
 * `minTread`, else drawn toward the staircase within its span. `slope` is
 * elevation per map unit.
 */
export function kernelTerrace<F, U, B>(
  m: KernelMath<F, U, B>,
  height: F,
  slope: F,
  terrace: KernelTerraceSettings
): F {
  const knots = terrace.levels.map(elevationAtDepth).sort((a, b) => a - b);
  const [deepest] = knots;
  const shallowest = knots.at(-1);
  if (deepest === undefined || shallowest === undefined || knots.length < 2) {
    return height;
  }
  const smoothstep = (low: F | number, high: F | number, value: F | number) => {
    const t = m.min(1, m.max(0, m.div(m.sub(value, low), m.sub(high, low))));
    return m.mul(m.mul(t, t), m.sub(3, m.mul(2, t)));
  };
  const strength = Math.min(1, Math.max(0, terrace.strength));
  const most = Math.min(1, Math.max(0, terrace.riser.most));
  const least = Math.min(most, Math.max(0, terrace.riser.least));
  // The span's knots: the highest at or below the height, the lowest above it.
  let lower: F = m.float(deepest);
  let upper: F = m.float(shallowest);
  for (const knot of knots) {
    lower = m.select(m.lt(height, knot), lower, knot);
  }
  for (const knot of [...knots].reverse()) {
    upper = m.select(m.lt(height, knot), knot, upper);
  }
  const span = m.sub(upper, lower);
  const t = m.div(m.sub(height, lower), span);
  // Map units the span would take across the slope here.
  const tread = m.select(m.lt(0, slope), m.div(span, slope), 1e30);
  const weight = m.mul(
    strength,
    smoothstep(terrace.minTread / 2, terrace.minTread, tread)
  );
  const half = m.div(
    m.min(most, m.max(least, m.div(terrace.riser.width, tread))),
    2
  );
  // `terraceStep`: a smooth riser `2 · half` wide on the nearer level.
  const level = m.floor(m.add(t, 0.5));
  const step = m.sub(
    m.add(level, smoothstep(m.mul(half, -1), half, m.sub(t, level))),
    0.5
  );
  const stepped = m.add(t, m.mul(weight, m.sub(step, t)));
  const terraced = m.min(
    upper,
    m.max(lower, m.add(lower, m.mul(stepped, span)))
  );
  const within = m.and(m.lt(deepest, height), m.lt(height, shallowest));
  return m.select(m.and(within, m.lt(0, weight)), terraced, height);
}
