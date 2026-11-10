/** The measure table: each measure of the glyph in the source font and in the edit. */
import { outlinePoints } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";
import { type Measure, measureOf } from "./bearings";

export interface MeasureRow {
  /** The difference the edit makes. Undefined when one side has no value. */
  readonly difference?: number;
  readonly edit?: number;
  /** The callout that keys the row to its line on the drawing. */
  readonly letter?: "A" | "B" | "C";
  /** Set when the row can be typed into and its line dragged. */
  readonly measure?: Measure;
  readonly name: string;
  /** Undefined for a glyph the project added: it has no source. */
  readonly source?: number;
}

const MEASURES: readonly {
  readonly letter: "A" | "B" | "C";
  readonly measure: Measure;
  readonly name: string;
}[] = [
  { letter: "A", measure: "advance", name: "Advance" },
  { letter: "B", measure: "left", name: "Left bearing" },
  { letter: "C", measure: "right", name: "Right bearing" },
];

const whole = (value: number | undefined) =>
  value === undefined ? undefined : Math.round(value);

const row = (
  name: string,
  source: number | undefined,
  edit: number | undefined
) => ({
  difference:
    source === undefined || edit === undefined ? undefined : edit - source,
  edit,
  name,
  source,
});

export const measureRows = (
  source: GlyphShape | undefined,
  edit: GlyphShape
): MeasureRow[] => [
  ...MEASURES.map(({ letter, measure, name }) => ({
    ...row(
      name,
      whole(source && measureOf(source, measure)),
      whole(measureOf(edit, measure))
    ),
    letter,
    measure,
  })),
  row(
    "Points",
    source && outlinePoints(source.outline).length,
    outlinePoints(edit.outline).length
  ),
];

/**
 * True when the edit's value is not the source font's: the project changed
 * it, or the project added the glyph and there is no source value at all.
 * Such a value is printed in carbon. One that still equals the source is the
 * source font's own, and is printed in ink.
 */
export const isChanged = ({ edit, source }: MeasureRow) =>
  edit !== undefined && edit !== source;
