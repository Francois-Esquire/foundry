/**
 * Places a glyph and the face's metric lines inside a drawing of a given size.
 * Font units have y up; the drawing has y down, so every y here is already
 * flipped and in drawing units.
 */
import type { FaceMetrics } from "~/typeface/face";
import type { Bounds } from "~/typeface/outline";

export interface FigureLine {
  /** False when the label would print over the line above it. */
  readonly labelled: boolean;
  readonly name: string;
  /** The line's height in font units. */
  readonly value: number;
  readonly y: number;
}

export interface GlyphFigure {
  /** Where the pen ends, in drawing units. */
  readonly advanceX: number;
  readonly baselineY: number;
  readonly height: number;
  readonly lines: readonly FigureLine[];
  /** Where the pen starts, in drawing units. */
  readonly originX: number;
  /** Drawing units per font unit. */
  readonly scale: number;
  readonly width: number;
}

export interface FigureInput {
  readonly advance: number;
  readonly bounds: Bounds | undefined;
  readonly metrics: FaceMetrics;
}

export interface FigureSize {
  readonly height: number;
  /** Room kept clear on each side for the line labels. */
  readonly margin: number;
  readonly width: number;
}

const PADDING = 14;
const LABEL_CLEARANCE = 11;

const metricLines = (metrics: FaceMetrics) =>
  [
    { name: "Ascender", value: metrics.ascender },
    { name: "Cap height", value: metrics.capHeight },
    { name: "x-height", value: metrics.xHeight },
    { name: "Baseline", value: 0 },
    { name: "Descender", value: metrics.descender },
  ].flatMap((line) =>
    line.value === undefined || (line.value === 0 && line.name !== "Baseline")
      ? []
      : [{ name: line.name, value: line.value }]
  );

export const layoutFigure = (
  { advance, bounds, metrics }: FigureInput,
  size: FigureSize
): GlyphFigure => {
  const top = Math.max(metrics.ascender, bounds?.yMax ?? 0);
  const bottom = Math.min(metrics.descender, bounds?.yMin ?? 0);
  const left = Math.min(0, bounds?.xMin ?? 0);
  const right = Math.max(advance, bounds?.xMax ?? 0);
  const scale = Math.min(
    (size.height - 2 * PADDING) / Math.max(1, top - bottom),
    (size.width - 2 * size.margin) / Math.max(1, right - left)
  );
  const baselineY = PADDING + top * scale;
  const originX = (size.width - (right - left) * scale) / 2 - left * scale;
  const sorted = metricLines(metrics).sort((a, b) => b.value - a.value);
  const lines: FigureLine[] = [];
  let lastLabelY = Number.NEGATIVE_INFINITY;
  for (const line of sorted) {
    const y = baselineY - line.value * scale;
    const labelled = y - lastLabelY >= LABEL_CLEARANCE;
    if (labelled) {
      lastLabelY = y;
    }
    lines.push({ ...line, labelled, y });
  }
  return {
    advanceX: originX + advance * scale,
    baselineY,
    height: size.height,
    lines,
    originX,
    scale,
    width: size.width,
  };
};
