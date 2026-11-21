import type { CellReference } from "../workbook/address";
import type { SavedSheet } from "../workbook/file";
import type { CellValue } from "../workbook/value";

export abstract class FormulaEngine {
  abstract calculate(sheets: readonly SavedSheet[]): Calculation;

  abstract renameSheetReferences(
    sheets: readonly SavedSheet[],
    from: string,
    to: string
  ): readonly FormulaRewrite[];
}

export abstract class Calculation {
  abstract value(reference: CellReference): CellValue;

  abstract close(): void;
}

export interface FormulaRewrite {
  readonly contents: string;
  readonly reference: CellReference;
}
