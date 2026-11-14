import { expect, it } from "vitest";
import { Calculation, FormulaEngine } from "../calculation/engine";
import { HyperFormulaEngine } from "../calculation/hyperformula";
import type { SavedSheet } from "../workbook/file";
import { Workbook } from "../workbook/workbook";
import { specifyFormulaEngine } from "./helpers/engine-specification";
import { workbooks } from "./helpers/workbooks";

specifyFormulaEngine("HyperFormulaEngine", () => new HyperFormulaEngine());

/** HyperFormula, until told to fail the way a broken engine would. */
class FailingEngine extends HyperFormulaEngine {
  failing: boolean;

  constructor() {
    super();
    this.failing = false;
  }

  override calculate(sheets: readonly SavedSheet[]): Calculation {
    if (this.failing) {
      throw new Error("Engine refused snapshot");
    }
    return super.calculate(sheets);
  }
}

it("keeps entered formula spelling through unrelated structural edits and reopening", () => {
  const workbook = workbooks.create();
  const reference = { cell: "A1", sheet: "Sheet1" };
  workbook.enter(reference, "=sum( A2 , 1 )");
  workbook.addSheet("Other");
  workbook.renameSheet("Other", "Elsewhere");
  workbook.renameSheet("Sheet1", "Inputs");
  const moved = { ...reference, sheet: "Inputs" };
  expect(workbook.contents(moved)).toBe("=sum( A2 , 1 )");
  const reopened = workbooks.open(workbook.toFile());
  expect(reopened.contents(moved)).toBe("=sum( A2 , 1 )");
  expect(reopened.value(moved)).toEqual({ kind: "number", value: 1 });
  workbook.close();
  reopened.close();
});

it("refuses an edit whose calculation fails and keeps its previous state", () => {
  const engine = new FailingEngine();
  const workbook = Workbook.create(engine);
  const A1 = { cell: "A1", sheet: "Sheet1" };
  workbook.enter(A1, "1");
  const before = workbook.toFile();
  engine.failing = true;
  expect(() => workbook.enter(A1, "2")).toThrow("Engine refused snapshot");
  expect(() => workbook.renameSheet("Sheet1", "Renamed")).toThrow(
    "Engine refused snapshot"
  );
  expect(() => workbook.addSheet()).toThrow("Engine refused snapshot");
  expect(workbook.toFile()).toBe(before);
  expect(workbook.sheets).toEqual(["Sheet1"]);
  expect(workbook.value(A1)).toEqual({ kind: "number", value: 1 });
  workbook.close();
});

it("depends on the FormulaEngine specification alone", () => {
  // Shows the Workbook reaches its engine only through the specification.
  // It says nothing about whether another real engine would pass the
  // specification suite above.
  class Constant extends Calculation {
    value() {
      return { kind: "number", value: 42 } as const;
    }
    close() {
      // Holds nothing.
    }
  }
  class ConstantEngine extends FormulaEngine {
    calculate() {
      return new Constant();
    }
    renameSheetReferences() {
      return [];
    }
  }
  const workbook = Workbook.create(new ConstantEngine());
  workbook.enter({ cell: "B2", sheet: "Sheet1" }, "=anything()");
  expect(workbook.value({ cell: "B2", sheet: "Sheet1" })).toEqual({
    kind: "number",
    value: 42,
  });
  expect(workbook.contents({ cell: "B2", sheet: "Sheet1" })).toBe(
    "=anything()"
  );
  workbook.close();
  workbook.close();
});

it("records HyperFormula's answers where the specification leaves the engine free", () => {
  // Not part of the specification: another engine may differ here. Kept so
  // a change of engine shows which of these workbooks would change.
  const workbook = workbooks.open(
    JSON.stringify({
      format: "foundry.workbook/1",
      sheets: [
        {
          cells: {
            A1: "=2^3^2",
            A2: "=-2^2",
            A3: "=10%",
            A4: '="2"*3',
            A5: "=TRUE",
            A6: '="a"="A"',
            B1: "=SEQUENCE(2)",
            C1: "=SEQUENCE(2)",
            C2: "blocks the spill",
          },
          name: "Sheet1",
        },
      ],
    })
  );
  const at = (cell: string) => workbook.value({ cell, sheet: "Sheet1" });
  expect(at("A1")).toEqual({ kind: "number", value: 64 });
  expect(at("A2")).toEqual({ kind: "number", value: 4 });
  expect(at("A3")).toEqual({ kind: "number", value: 0.1 });
  expect(at("A4")).toEqual({ kind: "number", value: 6 });
  expect(at("A5")).toMatchObject({ kind: "error", value: "#NAME?" });
  expect(at("A6")).toEqual({ kind: "boolean", value: true });
  // Arrays spill into empty cells, which have no contents to save.
  expect(at("B2")).toEqual({ kind: "number", value: 2 });
  expect(workbook.contents({ cell: "B2", sheet: "Sheet1" })).toBe("");
  expect(JSON.parse(workbook.toFile()).sheets[0].cells.B2).toBeUndefined();
  expect(at("C1")).toMatchObject({ kind: "error", value: "#SPILL!" });
  workbook.close();
});
