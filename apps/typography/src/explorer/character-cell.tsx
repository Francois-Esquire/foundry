import { memo } from "react";
import { GlyphDrawing } from "~/library/outline-drawing";
import type { Face } from "~/typeface/face";
import type { GlyphShape } from "~/typeface/reading";
import { GlyphCell } from "~/ui/content/glyph-cell";
import type { CharacterStatus } from "~/unicode/coverage";
import { cellStateOf } from "./character-status";

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
  readonly status: CharacterStatus;
}

/**
 * One character of the grid: the face's real glyph, or the crossed box when
 * the face has none. The frame around it follows the coverage status.
 */
export const CharacterCell = memo(function Cell({
  codePoint,
  face,
  onSelect,
  selected,
  setAsText,
  shape,
  status,
}: CharacterCellProps) {
  const text = setAsText ? String.fromCodePoint(codePoint) : null;
  return (
    <GlyphCell
      codePoint={codePoint}
      onSelect={onSelect}
      selected={selected}
      state={cellStateOf(status)}
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
