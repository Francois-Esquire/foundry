import { type Outline, outlineBounds, outlineToPath } from "~/typeface/outline";
import type { RecoveryMetrics } from "./core";

interface OutlineFigureProps {
  readonly advance: number;
  readonly metrics: RecoveryMetrics;
  /** What the picture shows, for someone who cannot see it. */
  readonly name: string;
  readonly outline: Outline;
}

/** Room left around the em, as a share of it. */
const MARGIN = 0.04;

/**
 * A candidate drawn in carbon on its baseline, between the face's ascender
 * and descender, with hairlines at the baseline and at its advance.
 */
export function OutlineFigure({
  advance,
  metrics,
  name,
  outline,
}: OutlineFigureProps) {
  const bounds = outlineBounds(outline);
  const margin = metrics.unitsPerEm * MARGIN;
  // Every figure of a face is one em wide at least, so a row of them lines up.
  const inkLeft = Math.min(0, bounds?.xMin ?? 0);
  const inkRight = Math.max(advance, bounds?.xMax ?? 0);
  const spare = Math.max(0, metrics.unitsPerEm - (inkRight - inkLeft)) / 2;
  const left = inkLeft - spare - margin;
  const right = inkRight + spare + margin;
  const top = Math.max(metrics.ascender, bounds?.yMax ?? 0);
  const bottom = Math.min(metrics.descender, bounds?.yMin ?? 0);
  return (
    <svg
      aria-label={name}
      className="ty-reconstruct-glyph"
      role="img"
      viewBox={`${left} ${-top - margin} ${right - left} ${top - bottom + 2 * margin}`}
    >
      <path
        className="ty-reconstruct-guide"
        d={`M${left} 0H${right}M0 ${-top}V${-bottom}M${advance} ${-top}V${-bottom}`}
      />
      <path
        className="ty-reconstruct-form"
        d={outlineToPath(outline)}
        transform="scale(1 -1)"
      />
    </svg>
  );
}
