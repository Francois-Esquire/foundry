import type { WorkingFace } from "~/typeface/changes";
import type { FaceMetrics } from "~/typeface/face";
import { outlineToPath } from "~/typeface/outline";
import type { PlacedGlyph, SetLine } from "~/typeface/typesetting";
import { ScrollRegion } from "~/ui/layout/scroll-region";

interface SpecimenLineProps {
  readonly line: SetLine;
  readonly metrics: FaceMetrics;
  /** Pixels per em. Fixed, so a wider advance makes a wider line. */
  readonly size: number;
  /** Decides which glyphs are drawn in carbon: the ones made after the source font. */
  readonly working: WorkingFace;
}

/** The share of an em a missing character's crossed box takes when it has no advance. */
const TOFU_WIDTH = 0.5;

const isMade = (working: WorkingFace, glyph: PlacedGlyph) =>
  glyph.ref.kind === "added" || working.overrides.has(glyph.ref.glyphId);

/**
 * One line of text set over the working face, drawn from outlines so an edit
 * shows the moment it is made. Source glyphs are ink, edited and added
 * glyphs carbon, and a character the face cannot draw is a crossed box.
 */
export function SpecimenLine({
  line,
  metrics,
  size,
  working,
}: SpecimenLineProps) {
  const scale = size / metrics.unitsPerEm;
  const height = (metrics.ascender - metrics.descender) * scale;
  const tofu = metrics.unitsPerEm * TOFU_WIDTH;
  return (
    <ScrollRegion axis="x" label="Specimen line">
      <svg
        aria-hidden="true"
        className="ty-studio-specimen-line"
        data-width-units={line.width}
        height={height}
        width={Math.max(1, line.width * scale)}
      >
        <g
          transform={`translate(0 ${metrics.ascender * scale}) scale(${scale} ${-scale})`}
        >
          {line.glyphs.map((glyph, index) =>
            glyph.missing ? (
              <path
                className="ty-studio-tofu"
                d={`M${glyph.x} 0h${glyph.advance || tofu}V${metrics.capHeight ?? metrics.ascender}h${-(glyph.advance || tofu)}ZL${glyph.x + (glyph.advance || tofu)} ${metrics.capHeight ?? metrics.ascender}M${glyph.x} ${metrics.capHeight ?? metrics.ascender}L${glyph.x + (glyph.advance || tofu)} 0`}
                key={index}
              />
            ) : (
              <path
                d={outlineToPath(glyph.outline)}
                data-made={isMade(working, glyph)}
                key={index}
                transform={`translate(${glyph.x} ${glyph.y})`}
              />
            )
          )}
        </g>
      </svg>
    </ScrollRegion>
  );
}
