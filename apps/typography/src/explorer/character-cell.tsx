import { memo } from "react";
import { GlyphDrawing } from "~/library/outline-drawing";
import type { Face } from "~/typeface/face";
import type { GlyphShape } from "~/typeface/reading";
import { GlyphCell, type GlyphCellState } from "~/ui/content/glyph-cell";

interface CharacterCellProps {
  readonly codePoint: number;
  readonly face: Face;
  readonly onSelect: (codePoint: number) => void;
  readonly selected: boolean;
  /**
   * True when the grid's font is the face's own, loaded. Until then a cell
   * without a shape stays blank, so no other font ever stands in.
   */
  readonly setAsText: boolean;
  /** The outline to draw, for work made after the source or a face with no font. */
  readonly shape: GlyphShape | undefined;
  /** The frame of the cell, from the coverage status and the candidate's provenance. */
  readonly state: GlyphCellState;
}

/**
 * One character of the grid: the face's real glyph, or the crossed box when
 * the face has none. The frame around it follows the coverage status, and
 * for a candidate where the design came from.
 */
export const CharacterCell = memo(function Cell({
  codePoint,
  face,
  onSelect,
  selected,
  setAsText,
  shape,
  state,
}: CharacterCellProps) {
  const text = setAsText ? String.fromCodePoint(codePoint) : null;
  return (
    <GlyphCell
      codePoint={codePoint}
      onSelect={onSelect}
      selected={selected}
      state={state}
    >
      {shape ? (
        <GlyphDrawing
          advance={shape.advance}
          metrics={face.description.metrics}
          outline={shape.outline}
        />
      ) : (
        text
      )}
    </GlyphCell>
  );
});
