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
    dateFormats: [],
    licenseKey: "gpl-v3",
    maxColumns: MAX_COLUMNS,
    maxRows: MAX_ROWS,
    timeFormats: [],
  });
  try {
    engine.suspendEvaluation();
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

function typed(contents: string): RawCellContent {
  const read = readContents(contents);
  switch (read.kind) {
    case "formula":
      return read.formula;
    case "text":
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
