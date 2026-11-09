import type { Calculation, FormulaEngine } from "../calculation/engine";
import { type CellReference, positionOf } from "./address";
import { WorkbookError } from "./errors";
import { formatWorkbookFile, parseWorkbookFile, type SavedSheet } from "./file";
import type { CellValue } from "./value";

export const MAX_SHEETS = 64;
export const MAX_CONTENTS_LENGTH = 32_767;
const MAX_SHEET_NAME_LENGTH = 31;
const NOT_IN_SHEET_NAME = /['[\]:*?/\\]/;

/**
 * A workbook: named sheets of typed contents. It is the only way to change
 * one, and every change is atomic. The Workbook validates the next
 * contents, writes their file and has the engine calculate them before
 * anything is replaced, so a refused change (a broken rule, a file over the
 * size limit, an engine failure) leaves contents, file and values as they
 * were.
 *
 * Each change recalculates the whole workbook in a new calculation and
 * writes the whole file. That keeps atomicity simple and is fast enough for
 * the files Sheets saves (see `WORKBOOK_MAX_BYTES`); incremental
 * recalculation is future work.
 */
export class Workbook {
  readonly #engine: FormulaEngine;
  #calculation: Calculation;
  #sheets: readonly SavedSheet[];
  #file: string;

  private constructor(sheets: readonly SavedSheet[], engine: FormulaEngine) {
    validate(sheets);
    this.#file = formatWorkbookFile(sheets);
    this.#engine = engine;
    this.#sheets = sheets;
    this.#calculation = engine.calculate(sheets);
  }

  /** A workbook with one empty sheet, `Sheet1`. */
  static create(engine: FormulaEngine): Workbook {
    return new Workbook([{ cells: {}, name: "Sheet1" }], engine);
  }

  /**
   * Opens a workbook file. Refuses one that breaks a rule as
   * `invalid-file`, and one whose file Sheets could not save as `too-large`.
   */
  static open(file: string, engine: FormulaEngine): Workbook {
    const sheets = parseWorkbookFile(file);
    try {
      return new Workbook(sheets, engine);
    } catch (error) {
      if (error instanceof WorkbookError && error.code !== "too-large") {
        throw new WorkbookError(error.message, {
          cause: error,
          code: "invalid-file",
        });
      }
      throw error;
    }
  }

  get sheets(): readonly string[] {
    return this.#sheets.map((sheet) => sheet.name);
  }

  /** What was typed in the cell, exactly as typed; empty when nothing was. */
  contents(reference: CellReference): string {
    positionOf(reference.cell);
    return this.#sheet(reference.sheet).cells[reference.cell] ?? "";
  }

  value(reference: CellReference): CellValue {
    this.contents(reference);
    return this.#calculation.value(reference);
  }

  /** Types contents into a cell; empty contents clear it. */
  enter(reference: CellReference, contents: string): void {
    this.contents(reference);
    this.#replace(
      this.#sheets.map((sheet) => {
        if (sheet.name !== reference.sheet) {
          return sheet;
        }
        const cells = { ...sheet.cells };
        if (contents === "") {
          delete cells[reference.cell];
        } else {
          cells[reference.cell] = contents;
        }
        return { cells, name: sheet.name };
      })
    );
  }

  /** Adds an empty sheet at the end and returns its name. */
  addSheet(name = this.#nextSheetName()): string {
    this.#replace([...this.#sheets, { cells: {}, name }]);
    return name;
  }

  /** Renames a sheet and rewrites the formulas that refer to it. */
  renameSheet(name: string, to: string): void {
    this.#sheet(name);
    if (to === name) {
      return;
    }
    const renamed = this.#sheets.map((sheet) => ({
      cells: { ...sheet.cells },
      name: sheet.name === name ? to : sheet.name,
    }));
    // Check the new name before the engine sees it.
    validate(renamed);
    for (const { reference, contents } of this.#engine.renameSheetReferences(
      this.#sheets,
      name,
      to
    )) {
      const sheet = renamed.find((item) => item.name === reference.sheet);
      if (sheet) {
        sheet.cells[reference.cell] = contents;
      }
    }
    this.#replace(renamed);
  }

  /**
   * Removes a sheet. Formulas that referred to it keep their contents and
   * show `#REF!` until a sheet of that name exists again.
   */
  removeSheet(name: string): void {
    this.#sheet(name);
    if (this.#sheets.length === 1) {
      throw new WorkbookError("A workbook keeps at least one sheet", {
        code: "last-sheet",
      });
    }
    this.#replace(this.#sheets.filter((sheet) => sheet.name !== name));
  }

  /** The workbook file. The same contents always give the same file. */
  toFile(): string {
    return this.#file;
  }

  /** Releases the calculation. Safe to call twice. */
  close(): void {
    this.#calculation.close();
  }

  #replace(sheets: readonly SavedSheet[]): void {
    validate(sheets);
    const file = formatWorkbookFile(sheets);
    const calculation = this.#engine.calculate(sheets);
    const previous = this.#calculation;
    this.#sheets = sheets;
    this.#file = file;
    this.#calculation = calculation;
    previous.close();
  }

  #sheet(name: string): SavedSheet {
    const sheet = this.#sheets.find((item) => item.name === name);
    if (!sheet) {
      throw new WorkbookError(`There is no sheet named "${name}"`, {
        code: "unknown-sheet",
      });
    }
    return sheet;
  }

  #nextSheetName(): string {
    const taken = new Set(this.sheets.map((name) => name.toLowerCase()));
    for (let number = this.#sheets.length + 1; ; number += 1) {
      const name = `Sheet${String(number)}`;
      if (!taken.has(name.toLowerCase())) {
        return name;
      }
    }
  }
}

function validate(sheets: readonly SavedSheet[]): void {
  if (sheets.length > MAX_SHEETS) {
    throw new WorkbookError("A workbook holds at most 64 sheets", {
      code: "too-many-sheets",
    });
  }
  const names = new Set<string>();
  for (const { name, cells } of sheets) {
    if (
      !name ||
      name.length > MAX_SHEET_NAME_LENGTH ||
      name !== name.trim() ||
      NOT_IN_SHEET_NAME.test(name)
    ) {
      throw new WorkbookError(
        "Use a sheet name of 1 to 31 characters without surrounding spaces or ' [ ] : * ? / \\",
        { code: "invalid-sheet-name" }
      );
    }
    if (names.has(name.toLowerCase())) {
      throw new WorkbookError(`There is already a sheet named "${name}"`, {
        code: "duplicate-sheet-name",
      });
    }
    names.add(name.toLowerCase());
    for (const [cell, contents] of Object.entries(cells)) {
      positionOf(cell);
      if (contents.length > MAX_CONTENTS_LENGTH) {
        throw new WorkbookError("A cell holds at most 32767 characters", {
          code: "contents-too-long",
        });
      }
    }
  }
}
