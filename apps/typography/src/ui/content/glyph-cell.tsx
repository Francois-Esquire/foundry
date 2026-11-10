import "./glyph-cell.css";
import { type ReactNode, useCallback } from "react";
import { codePointDigits, codePointName } from "./code-point";
import { CornerBrackets } from "./corner-brackets";
import { Tofu } from "./tofu";

/** Where the character stands in a face. Selection is a separate matter. */
export type GlyphCellState =
  | "candidate"
  | "edited"
  | "missing"
  | "observed"
  | "source";

const STATE_NAMES: Readonly<Record<GlyphCellState, string>> = {
  candidate: "candidate, not accepted",
  edited: "changed or added after the source font",
  missing: "missing",
  observed: "observed in the evidence, not accepted",
  source: "in the source font",
};

interface GlyphCellProps {
  /** The character's Unicode name, read out after the code point. */
  readonly characterName?: string;
  /** The letterform, set in the user's font by the caller. */
  readonly children?: ReactNode;
  readonly codePoint: number;
  /** Makes the cell a button. Without it the cell is a still image. */
  readonly onSelect?: (codePoint: number) => void;
  readonly selected?: boolean;
  readonly state: GlyphCellState;
}

/**
 * One character in a coverage grid: its letterform, or the crossed box when
 * it is missing, over its code point. A solid carbon frame is work in the
 * face. Work not yet accepted is dotted when it was generated or inferred,
 * and in corner brackets when it was traced from evidence.
 */
export function GlyphCell({
  characterName,
  children,
  codePoint,
  onSelect,
  selected = false,
  state,
}: GlyphCellProps) {
  const select = useCallback(
    () => onSelect?.(codePoint),
    [codePoint, onSelect]
  );
  const name = [codePointName(codePoint), characterName]
    .filter(Boolean)
    .join(" ");
  const spoken = `${name}, ${STATE_NAMES[state]}`;
  const body = (
    <>
      {state === "observed" ? <CornerBrackets /> : null}
      {state === "missing" ? (
        <Tofu size={21} />
      ) : (
        <span className="ty-glyph-cell-form">{children}</span>
      )}
      <span className="ty-code">{codePointDigits(codePoint)}</span>
    </>
  );
  return onSelect ? (
    <button
      aria-label={spoken}
      aria-pressed={selected}
      className="ty-glyph-cell"
      data-selected={selected}
      data-state={state}
      onClick={select}
      type="button"
    >
      {body}
    </button>
  ) : (
    <span
      aria-label={spoken}
      className="ty-glyph-cell"
      data-selected={selected}
      data-state={state}
      role="img"
    >
      {body}
    </span>
  );
}
