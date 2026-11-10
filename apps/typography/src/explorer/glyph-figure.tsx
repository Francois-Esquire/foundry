import "./coverage.css";
import { useMemo } from "react";
import type { FaceMetrics } from "~/typeface/face";
import { outlineToPath } from "~/typeface/outline";
import { layoutFigure } from "./figure-layout";
import type { InspectedGlyph } from "./inspection";

const SIZE = { height: 300, margin: 58, width: 340 } as const;

interface GlyphFigureProps {
  /** Carbon for work made after the source, ink for the source font. */
  readonly derived: boolean;
  /** A dotted frame marks a design that is not accepted yet. */
  readonly dotted: boolean;
  readonly glyph: InspectedGlyph;
  readonly metrics: FaceMetrics;
  /** Says what is drawn, for example "Outline of glyph ka-deva". */
  readonly title: string;
}

/**
 * A glyph's outline drawn large over the face's metric lines, with the pen's
 * start and end marked. Every line is one pixel at any size.
 */
export function GlyphFigure({
  derived,
  dotted,
  glyph,
  metrics,
  title,
}: GlyphFigureProps) {
  const figure = useMemo(
    () =>
      layoutFigure(
        { advance: glyph.advance, bounds: glyph.bounds, metrics },
        SIZE
      ),
    [glyph.advance, glyph.bounds, metrics]
  );
  const { advanceX, baselineY, height, lines, originX, scale, width } = figure;
  return (
    <svg
      aria-label={title}
      className="ty-coverage-figure"
      data-derived={derived}
      data-dotted={dotted}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      {lines.map((line) => (
        <g key={line.name}>
          <path
            className="ty-coverage-figure-line"
            d={`M0 ${line.y}H${width}`}
          />
          {line.labelled ? (
            <>
              <text className="ty-coverage-figure-label" x="0" y={line.y - 3}>
                {line.name.toUpperCase()}
              </text>
              <text
                className="ty-coverage-figure-label"
                textAnchor="end"
                x={width}
                y={line.y - 3}
              >
                {line.value}
              </text>
            </>
          ) : null}
        </g>
      ))}
      <path
        className="ty-coverage-figure-side"
        d={`M${originX} 0V${height}M${advanceX} 0V${height}`}
      />
      <path
        className="ty-coverage-figure-outline"
        d={outlineToPath(glyph.outline)}
        transform={`translate(${originX} ${baselineY}) scale(${scale} ${-scale})`}
      />
    </svg>
  );
}
