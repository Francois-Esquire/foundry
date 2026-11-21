import type { FormulaEngine } from "./calculation/engine";
import { HyperFormulaEngine } from "./calculation/hyperformula";
import { Workbook } from "./workbook/workbook";

export interface Workbooks {
  create(): Workbook;
  open(file: string): Workbook;
}

export async function loadWorkbooks(): Promise<Workbooks> {
  const engine: FormulaEngine = new HyperFormulaEngine();
  return {
    create: () => Workbook.create(engine),
    open: (file) => Workbook.open(file, engine),
  };
}
