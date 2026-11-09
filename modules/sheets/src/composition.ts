import type { FormulaEngine } from "./calculation/engine";
import { HyperFormulaEngine } from "./calculation/hyperformula";
import { Workbook } from "./workbook/workbook";

/** Makes workbooks calculated by the engine Sheets ships with. */
export interface Workbooks {
  create(): Workbook;
  open(file: string): Workbook;
}

/**
 * The one place that chooses the formula engine. It is asynchronous so an
 * engine that must load first (WebAssembly, a worker) can be awaited here,
 * before the editor starts, without changing the Workbook or the editor.
 */
export async function loadWorkbooks(): Promise<Workbooks> {
  const engine: FormulaEngine = new HyperFormulaEngine();
  return {
    create: () => Workbook.create(engine),
    open: (file) => Workbook.open(file, engine),
  };
}
