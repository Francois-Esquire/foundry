import type { FaceMetrics } from "~/typeface/face";
import { type Outline, outlineBounds, outlineToPath } from "~/typeface/outline";

interface GlyphDrawingProps {
  readonly advance: number;
  /** Height on screen in pixels. The width follows from the advance. */
  readonly height: number;
  readonly metrics: FaceMetrics;
  readonly outline: Outline;
  /** Ink for the source font, carbon for work made after it. */
  readonly tone: "carbon" | "ink";
}

/**
 * A glyph as a still picture, from the top of the ascender to the bottom of
 * the descender. Decoration: the text beside it names the glyph.
 */
export function GlyphDrawing({
  advance,
  height,
  metrics,
  outline,
  tone,
}: GlyphDrawingProps) {
  const bounds = outlineBounds(outline);
  const left = Math.min(0, bounds?.xMin ?? 0);
  const right = Math.max(advance, bounds?.xMax ?? 0, left + 1);
  const span = metrics.ascender - metrics.descender || 1;
  return (
    <svg
      aria-hidden="true"
      className="ty-studio-drawing"
      data-tone={tone}
      height={height}
      viewBox={`${left} ${-metrics.ascender} ${right - left} ${span}`}
      width={Math.max(1, ((right - left) / span) * height)}
    >
      <path d={outlineToPath(outline)} transform="scale(1 -1)" />
    </svg>
  );
}
