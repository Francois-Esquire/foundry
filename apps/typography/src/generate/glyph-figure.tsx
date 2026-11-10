import type { FaceMetrics } from "~/typeface/face";
import { type Outline, outlineBounds, outlineToPath } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";

interface GlyphFigureProps {
  readonly advance: number;
  /**
   * The face's own glyph for the same character. Drawn over the candidate
   * as an ink outline, so the two can be compared where they stand.
   */
  readonly holdout?: GlyphShape;
  readonly metrics: FaceMetrics;
  /** What the picture shows, for someone who cannot see it. */
  readonly name: string;
  readonly outline: Outline;
}

/** Room left around the em, as a share of it, so accents and tails stay inside. */
const MARGIN = 0.06;

/**
 * A candidate drawn large, in carbon, on its baseline between the face's
 * ascender and descender, with its advance marked by hairlines.
 */
export function GlyphFigure({
  advance,
  holdout,
  metrics,
  name,
  outline,
}: GlyphFigureProps) {
  const bounds = [outline, holdout?.outline]
    .map((drawn) => drawn && outlineBounds(drawn))
    .filter((box) => box !== undefined);
  const margin = metrics.unitsPerEm * MARGIN;
  const widest = Math.max(advance, holdout?.advance ?? 0);
  const left = Math.min(0, ...bounds.map((box) => box.xMin)) - margin;
  const right = Math.max(widest, ...bounds.map((box) => box.xMax)) + margin;
  const top = Math.max(metrics.ascender, ...bounds.map((box) => box.yMax));
  const bottom = Math.min(metrics.descender, ...bounds.map((box) => box.yMin));
  return (
    <svg
      aria-label={name}
      className="ty-generate-figure"
      role="img"
      viewBox={`${left} ${-top - margin} ${right - left} ${top - bottom + 2 * margin}`}
    >
      <path
        className="ty-generate-figure-guide"
        d={`M${left} 0H${right}M0 ${-top}V${-bottom}M${advance} ${-top}V${-bottom}`}
      />
      <g transform="scale(1 -1)">
        <path
          className="ty-generate-figure-candidate"
          d={outlineToPath(outline)}
        />
        {holdout ? (
          <path
            className="ty-generate-figure-holdout"
            d={outlineToPath(holdout.outline)}
          />
        ) : null}
      </g>
    </svg>
  );
}
