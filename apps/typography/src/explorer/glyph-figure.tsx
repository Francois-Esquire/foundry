import "./coverage.css";
import { useMemo } from "react";
import type { FaceMetrics } from "~/typeface/face";
import { outlineToPath } from "~/typeface/outline";
import { CornerBrackets } from "~/ui/content/corner-brackets";
import { layoutFigure } from "./figure-layout";
import type { InspectedGlyph } from "./inspection";

const SIZE = { height: 300, margin: 58, width: 340 } as const;

interface GlyphFigureProps {
  readonly glyph: InspectedGlyph;
  readonly metrics: FaceMetrics;
  /**
   * Where the glyph stands, as its cell in the grid shows it. The source
   * font is ink with no frame. Work made after it is carbon: a solid frame
   * in the face, dotted for a generated or inferred candidate, corner
   * brackets for a candidate observed in evidence.
   */
  readonly state: "candidate" | "edited" | "observed" | "source";
  /** Says what is drawn, for example "Outline of glyph ka-deva". */
  readonly title: string;
}

/**
 * A glyph's outline drawn large over the face's metric lines, with the pen's
 * start and end marked. Every line is one pixel at any size.
 */
export function GlyphFigure({
  glyph,
  metrics,
  state,
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
  const drawing = (
    <svg
      aria-label={title}
      className="ty-coverage-figure"
      data-state={state}
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
  // The brackets stand clear of the drawing, whose labels reach its corners.
  return state === "observed" ? (
    <div className="ty-coverage-figure-observed">
      <CornerBrackets />
      {drawing}
    </div>
  ) : (
    drawing
  );
}
