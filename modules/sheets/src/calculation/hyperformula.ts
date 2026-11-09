import {
  DetailedCellError,
  HyperFormula,
  type RawCellContent,
} from "hyperformula";
import {
  type CellReference,
  MAX_COLUMNS,
  MAX_ROWS,
  positionOf,
} from "../workbook/address";
import { readContents } from "../workbook/contents";
import type { SavedSheet } from "../workbook/file";
import type { CellValue } from "../workbook/value";
import { Calculation, FormulaEngine, type FormulaRewrite } from "./engine";

/**
 * HyperFormula 3.5 behind the FormulaEngine specification. A temporary
 * choice: HyperFormula is GPL-3.0-only unless a proprietary key is bought
 * (see the README), and it is used here under the GPL. Nothing from the
 * `hyperformula` package leaves this file.
 *
 * HyperFormula would read `10%` or `$10` as numbers, so values reach it
 * already typed by `readContents`, and text goes in quoted. Only formulas
 * are left for it to parse.
 */
export class HyperFormulaEngine extends FormulaEngine {
  calculate(sheets: readonly SavedSheet[]): Calculation {
    return new HyperFormulaCalculation(sheets);
  }

  renameSheetReferences(
    sheets: readonly SavedSheet[],
    from: string,
    to: string
  ): readonly FormulaRewrite[] {
    const engine = build(sheets);
    try {
      // HyperFormula stores references by sheet id and prints formulas
      // anew, so compare its printed formulas before and after instead of
      // replacing typed contents with its normalized spelling.
      const formulas = sheets.flatMap((sheet) =>
        Object.entries(sheet.cells)
          .filter(([, contents]) => contents.startsWith("="))
          .map(([cell]) => ({
            before: engine.getCellFormula(
              address(engine, { cell, sheet: sheet.name })
            ),
            reference: { cell, sheet: sheet.name === from ? to : sheet.name },
          }))
      );
      engine.renameSheet(sheetId(engine, from), to);
      return formulas.flatMap(({ before, reference }) => {
        const contents = engine.getCellFormula(address(engine, reference));
        return contents !== undefined && contents !== before
          ? [{ contents, reference }]
          : [];
      });
    } finally {
      engine.destroy();
    }
  }
}

class HyperFormulaCalculation extends Calculation {
  readonly #engine: HyperFormula;
  #closed: boolean;

  constructor(sheets: readonly SavedSheet[]) {
    super();
    this.#engine = build(sheets);
    this.#closed = false;
  }

  value(reference: CellReference): CellValue {
    return cellValue(
      this.#engine.getCellValue(address(this.#engine, reference))
    );
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#engine.destroy();
    }
  }
}

function build(sheets: readonly SavedSheet[]): HyperFormula {
  const engine = HyperFormula.buildEmpty({
    // No date or time parsing: typed dates stay text.
    dateFormats: [],
    licenseKey: "gpl-v3",
    maxColumns: MAX_COLUMNS,
    maxRows: MAX_ROWS,
    timeFormats: [],
  });
  try {
    engine.suspendEvaluation();
    // Every sheet exists before any formula is set, so references to a
    // sheet listed later resolve.
    for (const sheet of sheets) {
      engine.addSheet(sheet.name);
    }
    for (const sheet of sheets) {
      for (const [cell, contents] of Object.entries(sheet.cells)) {
        engine.setCellContents(
          address(engine, { cell, sheet: sheet.name }),
          typed(contents)
        );
      }
    }
    engine.resumeEvaluation();
    return engine;
  } catch (error) {
    engine.destroy();
    throw error;
  }
}

/** Contents as HyperFormula should take them, read the Sheets way. */
function typed(contents: string): RawCellContent {
  const read = readContents(contents);
  switch (read.kind) {
    case "formula":
      return read.formula;
    case "text":
      // HyperFormula reads a leading `'` as "the rest is text", too.
      return `'${read.value}`;
    default:
      return read.value;
  }
}

function sheetId(engine: HyperFormula, name: string): number {
  const id = engine.getSheetId(name);
  if (id === undefined) {
    throw new Error(`HyperFormula has no sheet named "${name}"`);
  }
  return id;
}

function address(engine: HyperFormula, { sheet, cell }: CellReference) {
  const { column, row } = positionOf(cell);
  return { col: column, row, sheet: sheetId(engine, sheet) };
}

function cellValue(value: ReturnType<HyperFormula["getCellValue"]>): CellValue {
  if (value instanceof DetailedCellError) {
    return { kind: "error", message: value.message, value: value.value };
  }
  if (value === null) {
    return { kind: "empty" };
  }
  if (typeof value === "number") {
    return { kind: "number", value };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", value };
  }
  return { kind: "text", value };
}
