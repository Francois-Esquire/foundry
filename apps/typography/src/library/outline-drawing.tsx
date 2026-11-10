import "./face.css";
import type { CSSProperties } from "react";
import type { FaceMetrics } from "~/typeface/face";
import { type Outline, outlineToPath } from "~/typeface/outline";
import type { SetLine } from "~/typeface/typesetting";

/** The em box of a face as an SVG view box, y flipped so the baseline is at 0. */
const viewBoxOf = (metrics: FaceMetrics, width: number) =>
  `0 ${-metrics.ascender} ${Math.max(1, width)} ${metrics.ascender - metrics.descender}`;

interface GlyphDrawingProps {
  readonly advance: number;
  /** Line height in em that the face's ascender to descender is fitted into. */
  readonly lineHeight?: number;
  readonly metrics: FaceMetrics;
  readonly outline: Outline;
}

/**
 * One glyph drawn from its outline in the current colour, sized by the font
 * size around it. Used where the browser's font cannot show the glyph: work
 * made after the source, and faces with no CSS family.
 */
export function GlyphDrawing({
  advance,
  lineHeight = 1.2,
  metrics,
  outline,
}: GlyphDrawingProps) {
  const extent = metrics.ascender - metrics.descender;
  const style: CSSProperties = {
    height: `${lineHeight}em`,
    width: `${(Math.max(1, advance) / extent) * lineHeight}em`,
  };
  return (
    <svg
      aria-hidden="true"
      className="ty-outline-drawing"
      style={style}
      viewBox={viewBoxOf(metrics, advance)}
    >
      <path d={outlineToPath(outline)} transform="scale(1 -1)" />
    </svg>
  );
}

interface LineDrawingProps {
  readonly line: SetLine;
  readonly metrics: FaceMetrics;
}

const DEFAULT_CAP_SHARE = 0.7;

/** The crossed box for a character with no glyph, in font units on the baseline. */
const crossedBox = (x: number, advance: number, metrics: FaceMetrics) => {
  const height =
    metrics.capHeight || Math.round(metrics.ascender * DEFAULT_CAP_SHARE);
  const width = Math.max(advance, height * 0.72);
  const inset = width * 0.1;
  const left = x + inset;
  const right = x + width - inset;
  return `M${left} 0H${right}V${-height}H${left}ZM${left} 0L${right} ${-height}M${right} 0L${left} ${-height}`;
};

/**
 * A line of set text drawn from outlines, one em tall per font size. A
 * character with no glyph gets the crossed box instead of the font's own
 * placeholder.
 */
export function LineDrawing({ line, metrics }: LineDrawingProps) {
  const extent = metrics.ascender - metrics.descender;
  const style: CSSProperties = {
    height: `${extent / metrics.unitsPerEm}em`,
    width: `${Math.max(1, line.width) / metrics.unitsPerEm}em`,
  };
  return (
    <svg
      aria-hidden="true"
      className="ty-outline-drawing"
      style={style}
      viewBox={viewBoxOf(metrics, line.width)}
    >
      {line.glyphs.map((glyph) =>
        glyph.missing ? (
          <path
            className="ty-outline-drawing-gap"
            d={crossedBox(glyph.x, glyph.advance, metrics)}
            key={`${glyph.cluster}:${glyph.x}`}
          />
        ) : (
          <path
            d={outlineToPath(glyph.outline)}
            key={`${glyph.cluster}:${glyph.x}`}
            transform={`translate(${glyph.x} ${-glyph.y}) scale(1 -1)`}
          />
        )
      )}
    </svg>
  );
}
