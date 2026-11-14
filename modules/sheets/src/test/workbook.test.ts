import { expect, it } from "vitest";
import { WorkbookError } from "../workbook/errors";
import { MAX_CONTENTS_LENGTH, MAX_SHEETS } from "../workbook/workbook";
import { workbooks as Workbook } from "./helpers/workbooks";

const at = (cell: string, sheet = "Sheet1") => ({ cell, sheet });

function refusal(change: () => unknown): string {
  try {
    change();
  } catch (error) {
    if (error instanceof WorkbookError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("The change was not refused");
}

it("calculates formulas and recalculates their dependents after an edit", () => {
  const workbook = Workbook.create();
  workbook.enter(at("A1"), "10");
  workbook.enter(at("A2"), "32");
  workbook.enter(at("A3"), "=SUM(A1:A2)");
  workbook.enter(at("B3"), "=A3/2");
  expect(workbook.value(at("B3"))).toEqual({ kind: "number", value: 21 });

  workbook.enter(at("A1"), "50");
  expect(workbook.value(at("A3"))).toEqual({ kind: "number", value: 82 });
  expect(workbook.value(at("B3"))).toEqual({ kind: "number", value: 41 });
  expect(workbook.contents(at("A3"))).toBe("=SUM(A1:A2)");
});

it("keeps typed text, booleans and quoted numbers as typed", () => {
  const workbook = Workbook.create();
  workbook.enter(at("A1"), "Revenue");
  workbook.enter(at("A2"), "TRUE");
  workbook.enter(at("A3"), "'0042");
  workbook.enter(at("A4"), "02/01/2026");
  expect(workbook.value(at("A1"))).toEqual({ kind: "text", value: "Revenue" });
  expect(workbook.value(at("A2"))).toEqual({ kind: "boolean", value: true });
  expect(workbook.value(at("A3"))).toEqual({ kind: "text", value: "0042" });
  expect(workbook.contents(at("A3"))).toBe("'0042");
  // No date formats: a typed date stays text instead of a serial number.
  expect(workbook.value(at("A4"))).toEqual({
    kind: "text",
    value: "02/01/2026",
  });
});

it("clears a cell entered as empty", () => {
  const workbook = Workbook.create();
  workbook.enter(at("A1"), "5");
  workbook.enter(at("B1"), "=A1+1");
  workbook.enter(at("A1"), "");
  expect(workbook.contents(at("A1"))).toBe("");
  expect(workbook.value(at("A1"))).toEqual({ kind: "empty" });
  expect(workbook.value(at("B1"))).toEqual({ kind: "number", value: 1 });
});

it("shows a bad formula as an error value instead of refusing it", () => {
  const workbook = Workbook.create();
  workbook.enter(at("A1"), "=SUM(");
  workbook.enter(at("A2"), "=1/0");
  workbook.enter(at("A3"), "=A3+1");
  workbook.enter(at("A4"), "=Missing!A1");
  expect(workbook.value(at("A1"))).toMatchObject({
    kind: "error",
    value: "#ERROR!",
  });
  expect(workbook.value(at("A2"))).toMatchObject({
    kind: "error",
    value: "#DIV/0!",
  });
  expect(workbook.value(at("A3"))).toMatchObject({
    kind: "error",
    value: "#CYCLE!",
  });
  expect(workbook.value(at("A4"))).toMatchObject({
    kind: "error",
    value: "#REF!",
  });
  expect(workbook.contents(at("A1"))).toBe("=SUM(");
});

it("recalculates formulas across sheets, and follows a renamed sheet", () => {
  const workbook = Workbook.create();
  workbook.renameSheet("Sheet1", "Inputs");
  expect(workbook.addSheet("My Data")).toBe("My Data");
  workbook.enter(at("B2", "Inputs"), "4");
  workbook.enter(at("A1", "My Data"), "=Inputs!B2*10");
  workbook.enter(at("C1", "Inputs"), "='My Data'!A1+1");
  expect(workbook.value(at("C1", "Inputs"))).toEqual({
    kind: "number",
    value: 41,
  });

  workbook.enter(at("B2", "Inputs"), "5");
  expect(workbook.value(at("A1", "My Data"))).toEqual({
    kind: "number",
    value: 50,
  });
  expect(workbook.value(at("C1", "Inputs"))).toEqual({
    kind: "number",
    value: 51,
  });

  workbook.renameSheet("Inputs", "Assumptions");
  expect(workbook.sheets).toEqual(["Assumptions", "My Data"]);
  expect(workbook.contents(at("A1", "My Data"))).toBe("=Assumptions!B2*10");
  expect(workbook.value(at("A1", "My Data"))).toEqual({
    kind: "number",
    value: 50,
  });
});

it("shows #REF! where a removed sheet was referred to", () => {
  const workbook = Workbook.create();
  const second = workbook.addSheet();
  expect(second).toBe("Sheet2");
  workbook.enter(at("A1", "Sheet2"), "7");
  workbook.enter(at("A1"), "=Sheet2!A1");
  workbook.removeSheet("Sheet2");
  expect(workbook.sheets).toEqual(["Sheet1"]);
  expect(workbook.value(at("A1"))).toMatchObject({
    kind: "error",
    value: "#REF!",
  });
  expect(workbook.contents(at("A1"))).toBe("=Sheet2!A1");

  // A sheet of that name brings the reference back.
  workbook.addSheet("Sheet2");
  workbook.enter(at("A1", "Sheet2"), "9");
  expect(workbook.value(at("A1"))).toEqual({ kind: "number", value: 9 });
});

it("refuses changes that break its rules and stays as it was", () => {
  const workbook = Workbook.create();
  workbook.enter(at("A1"), "1");
  expect(refusal(() => workbook.enter(at("A0"), "1"))).toBe("invalid-address");
  expect(refusal(() => workbook.enter(at("a1"), "1"))).toBe("invalid-address");
  expect(refusal(() => workbook.enter(at("AAA1"), "1"))).toBe(
    "invalid-address"
  );
  expect(refusal(() => workbook.enter(at("A10001"), "1"))).toBe(
    "invalid-address"
  );
  expect(refusal(() => workbook.value(at("A1", "Nope")))).toBe("unknown-sheet");
  expect(
    refusal(() => workbook.enter(at("A1"), "x".repeat(MAX_CONTENTS_LENGTH + 1)))
  ).toBe("contents-too-long");
  expect(workbook.contents(at("A1"))).toBe("1");

  expect(refusal(() => workbook.addSheet("sheet1"))).toBe(
    "duplicate-sheet-name"
  );
  for (const name of ["", " Padded", "It's", "a/b", "x".repeat(32)]) {
    expect(refusal(() => workbook.addSheet(name))).toBe("invalid-sheet-name");
  }
  expect(refusal(() => workbook.removeSheet("Sheet1"))).toBe("last-sheet");
  for (let count = 1; count < MAX_SHEETS; count += 1) {
    workbook.addSheet();
  }
  expect(refusal(() => workbook.addSheet())).toBe("too-many-sheets");
  expect(workbook.sheets).toHaveLength(MAX_SHEETS);
});

it("renames a sheet to a different case of its own name", () => {
  const workbook = Workbook.create();
  workbook.renameSheet("Sheet1", "SHEET1");
  expect(workbook.sheets).toEqual(["SHEET1"]);
  workbook.addSheet("Totals");
  expect(refusal(() => workbook.renameSheet("Totals", "sheet1"))).toBe(
    "duplicate-sheet-name"
  );
});
