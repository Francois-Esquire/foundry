import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import type { GlyphShape } from "~/typeface/reading";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import type { Measure } from "./bearings";
import { isChanged, type MeasureRow, measureRows } from "./measures";

/** The id of a measure's number field, so its callout on the drawing can lead to it. */
export const measureFieldId = (measure: Measure) =>
  `ty-studio-measure-${measure}`;

const WHOLE_NUMBER = /^[+-]?\d+$/;

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

/** The circled letter that keys a row to its line on the drawing. Empty for a row with no line. */
function CalloutLetter({ letter }: { readonly letter?: string }) {
  return (
    <svg
      aria-hidden="true"
      className="ty-studio-letter"
      height="20"
      viewBox="0 0 20 20"
      width="20"
    >
      {letter ? (
        <>
          <circle cx="10" cy="10" r="9" />
          <text textAnchor="middle" x="10" y="13.5">
            {letter}
          </text>
        </>
      ) : null}
    </svg>
  );
}

interface MeasureFieldProps {
  /** True when the value is no longer the source font's. */
  readonly changed: boolean;
  readonly measure: Measure;
  readonly name: string;
  readonly onCommit: (measure: Measure, value: number) => void;
  readonly value: number;
}

/** A measure as a number to type over. Enter or leaving the field sets it; Escape puts it back. */
function MeasureField({
  changed,
  measure,
  name,
  onCommit,
  value,
}: MeasureFieldProps) {
  const [draft, setDraft] = useState<string>();
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setDraft(event.currentTarget.value),
    []
  );
  const commit = useCallback(() => {
    const typed = draft?.trim() ?? "";
    setDraft(undefined);
    if (WHOLE_NUMBER.test(typed) && Number(typed) !== value) {
      onCommit(measure, Number(typed));
    }
  }, [draft, measure, onCommit, value]);
  const pressKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        commit();
      } else if (event.key === "Escape") {
        setDraft(undefined);
      }
    },
    [commit]
  );
  return (
    <input
      aria-label={`${name}, in font units`}
      className="ty-studio-measure-field"
      data-changed={changed}
      id={measureFieldId(measure)}
      inputMode="numeric"
      onBlur={commit}
      onChange={type}
      onKeyDown={pressKey}
      type="text"
      value={draft ?? String(value)}
    />
  );
}

const rowName = (row: MeasureRow) => row.name;

interface MeasureTableProps {
  /** Left out for a glyph that cannot be edited: its numbers are then only read. */
  readonly onCommit?: (measure: Measure, value: number) => void;
  readonly shape: GlyphShape;
  /** Absent for a glyph the project added. */
  readonly source?: GlyphShape;
}

/**
 * The glyph's measures in the source font and in the edit. The lettered rows
 * are the lines with the same letters on the drawing: typing a number here
 * and dragging the line there are the same control. A value the project has
 * not changed is the source font's, in ink; a changed one is in carbon.
 */
export function MeasureTable({ onCommit, shape, source }: MeasureTableProps) {
  const rows = useMemo(() => measureRows(source, shape), [shape, source]);
  const columns = useMemo(
    (): DataColumn<MeasureRow>[] => [
      {
        cell: (row) => (
          <span className="ty-studio-measure-name">
            <CalloutLetter letter={row.letter} />
            {row.name}
          </span>
        ),
        header: "Measure",
        id: "name",
        kind: "label",
      },
      {
        cell: (row) => row.source ?? "",
        header: "Source",
        id: "source",
        kind: "numeric",
      },
      {
        cell: (row) =>
          onCommit && row.measure && row.edit !== undefined ? (
            <MeasureField
              changed={isChanged(row)}
              measure={row.measure}
              name={row.name}
              onCommit={onCommit}
              value={row.edit}
            />
          ) : (
            <span
              className={isChanged(row) ? "ty-carbon" : undefined}
              data-changed={isChanged(row)}
            >
              {row.edit ?? ""}
            </span>
          ),
        header: "Edit",
        id: "edit",
        kind: "numeric",
      },
      {
        cell: (row) =>
          row.difference === undefined ? "" : signed(row.difference),
        header: "Difference",
        id: "difference",
        kind: "numeric",
      },
    ],
    [onCommit]
  );
  return (
    <DataTable
      caption="Measures of the glyph in the source font and in the edit, in font units"
      columns={columns}
      rowKey={rowName}
      rows={rows}
    />
  );
}
