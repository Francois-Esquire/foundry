import type { SetLine } from "./set-line";

interface WordFigureProps {
  /** The lowest and highest the figure has to show, in font units. */
  readonly extent: { readonly bottom: number; readonly top: number };
  /** Lines set one after another on one baseline. */
  readonly lines: readonly SetLine[];
  /** What the picture shows, for someone who cannot see it. */
  readonly name: string;
  readonly unitsPerEm: number;
}

/** Room around the text, and between two lines on one baseline, as shares of the em. */
const MARGIN = 0.06;
const GAP = 0.4;

interface PlacedGlyph {
  readonly added: boolean;
  readonly key: string;
  readonly path: string;
  readonly x: number;
  readonly y: number;
}

const placed = (
  lines: readonly SetLine[],
  gap: number
): { readonly glyphs: PlacedGlyph[]; readonly width: number } => {
  const glyphs: PlacedGlyph[] = [];
  let left = 0;
  for (const [lineNumber, line] of lines.entries()) {
    for (const [glyphNumber, glyph] of line.glyphs.entries()) {
      glyphs.push({
        added: glyph.added,
        key: `${lineNumber}:${glyphNumber}`,
        path: glyph.path,
        x: left + glyph.x,
        y: glyph.y,
      });
    }
    left += line.width + gap;
  }
  return { glyphs, width: Math.max(0, left - gap) };
};

/**
 * Text set in a built font's own outlines, on its baseline. Ink is a glyph
 * of the source font; carbon is a glyph made after it.
 */
export function WordFigure({
  extent,
  lines,
  name,
  unitsPerEm,
}: WordFigureProps) {
  const margin = unitsPerEm * MARGIN;
  const { glyphs, width } = placed(lines, unitsPerEm * GAP);
  return (
    <svg
      aria-label={name}
      className="ty-extension-word-figure"
      role="img"
      viewBox={`${-margin} ${-extent.top - margin} ${width + 2 * margin} ${extent.top - extent.bottom + 2 * margin}`}
    >
      <path
        className="ty-generate-figure-guide"
        d={`M${-margin} 0H${width + margin}`}
      />
      <g transform="scale(1 -1)">
        {glyphs.map((glyph) => (
          <path
            className={
              glyph.added
                ? "ty-extension-outline-added"
                : "ty-extension-outline-source"
            }
            d={glyph.path}
            key={glyph.key}
            transform={`translate(${glyph.x} ${glyph.y})`}
          />
        ))}
      </g>
    </svg>
  );
}
