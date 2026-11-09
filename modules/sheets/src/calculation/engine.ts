import type { CellReference } from "../workbook/address";
import type { SavedSheet } from "../workbook/file";
import type { CellValue } from "../workbook/value";

/**
 * The formula engine, specified as everything the Workbook asks of one.
 * The Workbook owns the contents people type; an engine only derives
 * values from them. No engine type, error or option crosses this seam, so
 * replacing the engine means writing one new subclass and changing
 * `composition.ts`.
 *
 * The Workbook validates every snapshot before an engine sees it: sheet
 * names are unique ignoring case, cells lie in A1:ZZ10000, and contents are
 * non-empty strings of at most 32767 characters. Engines may rely on that.
 *
 * Values. Engines read contents as `readContents` (workbook/contents.ts)
 * does: `=` starts a formula, a leading `'` makes the rest text, plain
 * numerals (`12`, `-3.5`, `.5`, `1e3`) are numbers, `TRUE` and `FALSE` in
 * any case are booleans, and everything else is text as typed: `10%`,
 * `$10`, `1,000`, ` 12` and `02/01/2026` are text.
 *
 * The portable formula dialect, which every engine calculates alike:
 * - References: `A1`, ranges `A1:B3`, absolute `$A$1`, other sheets as
 *   `Name!A1` or `'Name With Spaces'!A1`, including sheets listed later.
 *   Cell and sheet names ignore case.
 * - Operators, loosest first: comparisons `= <> < > <= >=` (between
 *   numbers), `&` (joins as text), `+ -`, `* /`, a single `^`. Operators of
 *   one level apply left to right. Parentheses group; `-` negates a
 *   reference or a parenthesized value.
 * - In arithmetic an empty cell is 0, and text that is not a numeral is
 *   `#VALUE!`.
 * - Functions, in any case: SUM, AVERAGE, MIN, MAX, COUNT, ABS, ROUND
 *   (halves away from zero), IF, AND, OR, NOT, TRUE() and FALSE(). Over a
 *   range, SUM, AVERAGE, MIN, MAX and COUNT count only numbers.
 * - Errors: `#DIV/0!` for division by zero, `#REF!` for a missing sheet,
 *   `#VALUE!` for arithmetic on text, `#NAME?` for an unknown function.
 *   A formula whose operand is an error has that error. Bad syntax and
 *   cycles are errors too, with a code the engine chooses.
 * - A formula's error `message` is the engine's explanation for people;
 *   its wording is not portable.
 *
 * Engine-specific: an engine may calculate these differently, give an
 * error, or not support them. A workbook relying on them can show other
 * values after a change of engine; its contents never change.
 * - Chained `^` (`=2^3^2`), `-` before `^` (`=-2^2`), and `%` in formulas.
 * - Comparing text, numerals in text used in arithmetic, and booleans
 *   used in arithmetic.
 * - `TRUE` and `FALSE` without parentheses inside formulas.
 * - Functions not listed above, whole rows or columns (`A:A`), references
 *   past ZZ10000, and the codes of syntax and cycle errors.
 * - Array results. An engine may spill one into the empty cells below and
 *   to the right; those cells show values but have no contents, so
 *   nothing of the spill is saved. Without spilling, the formula's own
 *   cell shows an engine-chosen value or error.
 * Otherwise a cell without contents is empty.
 *
 * Calculating never changes contents. Only `renameSheetReferences` returns
 * new contents, and only for formulas that refer to the renamed sheet.
 *
 * `src/test/helpers/engine-specification.ts` checks the portable rules
 * against an implementation; run it for every engine.
 */
export abstract class FormulaEngine {
  /**
   * Calculates a snapshot of a workbook's contents.
   *
   * A formula that cannot be calculated (bad syntax, a missing sheet, a
   * cycle, division by zero) gets an error value; that is not a failure.
   * Throws only when the engine itself fails, so the Workbook can refuse
   * the edit that produced the snapshot and keep its previous state.
   *
   * The calculation answers for this snapshot alone. Later calls build
   * separate calculations, and the snapshot is never modified.
   */
  abstract calculate(sheets: readonly SavedSheet[]): Calculation;

  /**
   * The formulas whose text must change so they still refer to sheet
   * `from` once it is named `to`. Each rewrite names its cell by the
   * sheet's name after the rename, and its contents are the rewritten
   * formula, quoting the name when needed.
   *
   * Formulas that do not refer to `from` are never returned, so contents
   * keep the spelling they were typed with. A rewritten formula may come
   * back in the engine's own spelling (for example `=sum(a1)` as
   * `=SUM(A1)`). A formula the engine cannot parse is not rewritten.
   *
   * Pure: the snapshot is not modified and no calculation is affected.
   * `from` names a sheet in the snapshot; `to` is a valid sheet name that
   * no other sheet uses, ignoring case.
   */
  abstract renameSheetReferences(
    sheets: readonly SavedSheet[],
    from: string,
    to: string
  ): readonly FormulaRewrite[];
}

/** A calculated snapshot. It holds engine resources until closed. */
export abstract class Calculation {
  /**
   * What the cell shows: `empty` for a cell with no contents, or the
   * spreadsheet error, such as `#DIV/0!`, with the engine's explanation.
   * The reference names a sheet in the snapshot and a cell in A1:ZZ10000.
   */
  abstract value(reference: CellReference): CellValue;

  /** Releases engine resources. Safe to call twice; `value` may not follow. */
  abstract close(): void;
}

/** New contents for one formula after a sheet rename. */
export interface FormulaRewrite {
  readonly contents: string;
  readonly reference: CellReference;
}
