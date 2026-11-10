/**
 * The contact sheet of a run: every candidate drawn over the glyph it is
 * compared with, at one scale, with its scores beneath.
 */
import type { Evaluation } from "~/generation/evaluation/evaluation";
import type { NewCandidate } from "~/generation/pipeline/stages";
import type { StyleReference } from "~/generation/style/reference";
import { type Outline, outlineToPath } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";

export interface ContactEntry {
  readonly candidate: NewCandidate;
  /** What the comparison glyph is: the source face's own, or another font's. */
  readonly comparedWith?: string;
  readonly evaluation?: Evaluation;
  readonly reference?: GlyphShape;
  readonly text: string;
}

const CELL_WIDTH = 300;
const CELL_HEIGHT = 340;
const DRAWING_HEIGHT = 230;
const COLUMNS = 6;
const INK = "#1b1b1b";
const CANDIDATE = "#1f5fbf";
const REFERENCE = "#c9c9c9";

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const score = (value: number | undefined) =>
  value === undefined ? "n/a" : value.toFixed(3);

const drawn = (
  outline: Outline,
  fill: string,
  opacity: number,
  placement: string
) =>
  `<path transform="${placement}" fill="${fill}" fill-opacity="${opacity}" d="${outlineToPath(outline)}"/>`;

const cell = (
  entry: ContactEntry,
  index: number,
  style: StyleReference
): string => {
  const left = (index % COLUMNS) * CELL_WIDTH;
  const top = Math.floor(index / COLUMNS) * CELL_HEIGHT;
  const { bottom, top: reach } = style.extent;
  const scale = DRAWING_HEIGHT / (reach - bottom);
  const baseline = top + 20 + reach * scale;
  const width = Math.max(
    entry.candidate.advance,
    entry.reference?.advance ?? 0
  );
  const x = left + (CELL_WIDTH - width * scale) / 2;
  const placement = `matrix(${scale} 0 0 ${-scale} ${x} ${baseline})`;
  const scores = entry.evaluation?.scores;
  const caption = [
    `${entry.text}  ${entry.candidate.name}  ${entry.evaluation?.verdict ?? ""}`,
    entry.reference
      ? `shape ${score(scores?.shape)} aligned, ${score(scores?.shapeInPlace)} in place`
      : "no glyph to compare with",
    entry.reference ? `grey: ${entry.comparedWith ?? ""}` : "",
  ];
  return [
    `<line x1="${left + 10}" x2="${left + CELL_WIDTH - 10}" y1="${baseline}" y2="${baseline}" stroke="${REFERENCE}" stroke-width="0.5"/>`,
    entry.reference
      ? drawn(entry.reference.outline, REFERENCE, 1, placement)
      : "",
    drawn(entry.candidate.outline, CANDIDATE, 0.72, placement),
    ...caption.map(
      (line, row) =>
        `<text x="${left + 12}" y="${top + DRAWING_HEIGHT + 52 + row * 16}" font-family="sans-serif" font-size="11" fill="${INK}">${escapeXml(line)}</text>`
    ),
  ].join("\n");
};

/** Blue is the candidate, drawn over the grey glyph it is compared with. */
export const contactSheet = (
  title: string,
  entries: readonly ContactEntry[],
  style: StyleReference
): string => {
  const rows = Math.max(1, Math.ceil(entries.length / COLUMNS));
  const width = COLUMNS * CELL_WIDTH;
  const height = rows * CELL_HEIGHT + 40;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<text x="12" y="${height - 14}" font-family="sans-serif" font-size="12" fill="${INK}">${escapeXml(title)}</text>`,
    ...entries.map((entry, index) => cell(entry, index, style)),
    "</svg>",
  ].join("\n");
};
