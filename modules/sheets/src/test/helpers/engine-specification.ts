import { describe, expect, it } from "vitest";
import type { Calculation, FormulaEngine } from "../../calculation/engine";
import type { SavedSheet } from "../../workbook/file";

const SPREADSHEET_ERROR = /^#/;

/**
 * The FormulaEngine specification as tests. Every engine Sheets can be
 * composed with runs this suite; passing it is what "supports the
 * specification" means. It checks behavior through the specification's
 * operations only, never engine internals.
 */
export function specifyFormulaEngine(
  name: string,
  makeEngine: () => FormulaEngine
): void {
  const frozen = (sheets: SavedSheet[]): readonly SavedSheet[] =>
    Object.freeze(
      sheets.map((sheet) =>
        Object.freeze({
          cells: Object.freeze({ ...sheet.cells }),
          name: sheet.name,
        })
      )
    );

  function calculated<T>(
    sheets: readonly SavedSheet[],
    use: (calculation: Calculation) => T
  ): T {
    const calculation = makeEngine().calculate(sheets);
    try {
      return use(calculation);
    } finally {
      calculation.close();
    }
  }

  /** The values of `cells` once the rename's rewrites are applied. */
  function afterRename(
    sheets: readonly SavedSheet[],
    from: string,
    to: string
  ) {
    const rewrites = makeEngine().renameSheetReferences(sheets, from, to);
    const renamed = sheets.map((sheet) => ({
      cells: { ...sheet.cells },
      name: sheet.name === from ? to : sheet.name,
    }));
    for (const { reference, contents } of rewrites) {
      const sheet = renamed.find((item) => item.name === reference.sheet);
      if (!sheet) {
        throw new Error(`A rewrite names a missing sheet: ${reference.sheet}`);
      }
      sheet.cells[reference.cell] = contents;
    }
    return { renamed: frozen(renamed), rewrites };
  }

  describe(`${name} meets the FormulaEngine specification`, () => {
    /** The values of Sheet1's cells in a one-sheet snapshot. */
    function values(cells: Record<string, string>): Record<string, unknown> {
      return calculated(frozen([{ cells, name: "Sheet1" }]), (calculation) =>
        Object.fromEntries(
          Object.keys(cells).map((cell) => [
            cell,
            calculation.value({ cell, sheet: "Sheet1" }),
          ])
        )
      );
    }
    const number = (value: number) => ({ kind: "number", value });
    const text = (value: string) => ({ kind: "text", value });
    const boolean = (value: boolean) => ({ kind: "boolean", value });
    const error = (value: string) => ({
      kind: "error",
      message: expect.any(String),
      value,
    });

    it("reads plain numerals as numbers, TRUE and FALSE as booleans, and the rest as text", () => {
      expect(
        values({
          A1: "12.5",
          A2: "-3",
          A3: ".5",
          A4: "1e3",
          A5: "+4",
          B1: "TRUE",
          B2: "false",
          C1: "Revenue",
          C2: "'007",
          C3: "'TRUE",
          C4: "02/01/2026",
          C5: "10%",
          C6: "$10",
          C7: "1,000",
          C8: " 12",
          C9: "'=1+1",
        })
      ).toEqual({
        A1: number(12.5),
        A2: number(-3),
        A3: number(0.5),
        A4: number(1000),
        A5: number(4),
        B1: boolean(true),
        B2: boolean(false),
        C1: text("Revenue"),
        C2: text("007"),
        C3: text("TRUE"),
        C4: text("02/01/2026"),
        C5: text("10%"),
        C6: text("$10"),
        C7: text("1,000"),
        C8: text(" 12"),
        C9: text("=1+1"),
      });
      calculated(frozen([{ cells: {}, name: "Sheet1" }]), (calculation) => {
        expect(calculation.value({ cell: "ZZ10000", sheet: "Sheet1" })).toEqual(
          { kind: "empty" }
        );
      });
    });

    it("applies operators by precedence, left to right within a level", () => {
      expect(
        values({
          A1: "=1+2*3",
          A2: "=(1+2)*3",
          A3: "=2*3^2",
          A4: "=10-4-3",
          A5: "=12/2/3",
          A6: "=-(2)+1",
          B1: '="a"&1+2',
          B2: "=1&2",
          C1: "=1+2=3",
          C2: "=1<>2",
          C3: "=2>=3",
          C4: "=2<3",
        })
      ).toEqual({
        A1: number(7),
        A2: number(9),
        A3: number(18),
        A4: number(3),
        A5: number(2),
        A6: number(-1),
        B1: text("a3"),
        B2: text("12"),
        C1: boolean(true),
        C2: boolean(true),
        C3: boolean(false),
        C4: boolean(true),
      });
    });

    it("counts empty cells as 0 in arithmetic and refuses text that is not a numeral", () => {
      expect(
        values({
          A1: "4",
          A2: "Revenue",
          B1: "=Z99+1",
          B2: "=A2*2",
          B3: '="x"+1',
          B4: "=-A1",
        })
      ).toMatchObject({
        B1: number(1),
        B2: error("#VALUE!"),
        B3: error("#VALUE!"),
        B4: number(-4),
      });
    });

    it("calculates the required functions in any case, counting only numbers over a range", () => {
      expect(
        values({
          A1: "4",
          A2: "Revenue",
          A3: "TRUE",
          A5: "10",
          B1: "=SUM(A1:A5)",
          B2: "=average(A1:A5)",
          B3: "=MIN(A1:A5)",
          B4: "=Max(A1:A5)",
          B5: "=COUNT(A1:A5)",
          C1: "=ABS(-2.5)",
          C2: "=ROUND(2.5,0)",
          C3: "=ROUND(-1.25,1)",
          C4: "=ROUND(1.234,2)",
          D1: '=IF(A1>3,"big","small")',
          D2: "=AND(TRUE(),FALSE())",
          D3: "=OR(A1>5,A3)",
          D4: "=NOT(A3)",
          D5: "=SUM(1,2,3)",
        })
      ).toMatchObject({
        B1: number(14),
        B2: number(7),
        B3: number(4),
        B4: number(10),
        B5: number(2),
        C1: number(2.5),
        C2: number(3),
        C3: number(-1.3),
        C4: number(1.23),
        D1: text("big"),
        D2: boolean(false),
        D3: boolean(true),
        D4: boolean(false),
        D5: number(6),
      });
    });

    it("refers to cells and sheets ignoring case, with absolute references", () => {
      const sheets = frozen([
        { cells: { A1: "3" }, name: "Inputs" },
        {
          cells: { A1: "=$A$2*2", A2: "=inputs!a1+INPUTS!$A$1" },
          name: "Totals",
        },
      ]);
      calculated(sheets, (calculation) => {
        expect(calculation.value({ cell: "A2", sheet: "Totals" })).toEqual(
          number(6)
        );
        expect(calculation.value({ cell: "A1", sheet: "Totals" })).toEqual(
          number(12)
        );
      });
    });

    it("calculates formulas across sheets, including sheets listed later and quoted names", () => {
      const sheets = frozen([
        {
          cells: {
            A1: "=Later!A1+1",
            A2: "='My Data'!B2*2",
            A3: "=SUM(A1:A2)",
          },
          name: "First",
        },
        { cells: { A1: "41" }, name: "Later" },
        { cells: { B2: "4" }, name: "My Data" },
      ]);
      calculated(sheets, (calculation) => {
        const at = (cell: string) =>
          calculation.value({ cell, sheet: "First" });
        expect(at("A1")).toEqual({ kind: "number", value: 42 });
        expect(at("A2")).toEqual({ kind: "number", value: 8 });
        expect(at("A3")).toEqual({ kind: "number", value: 50 });
      });
    });

    it("gives formulas that cannot be calculated an error value instead of failing", () => {
      const sheets = frozen([
        {
          cells: { A1: "=SUM(", A2: "=1/0", A3: "=A3+1", A4: "=Missing!A1" },
          name: "Sheet1",
        },
      ]);
      calculated(sheets, (calculation) => {
        const at = (cell: string) =>
          calculation.value({ cell, sheet: "Sheet1" });
        const anError = {
          kind: "error",
          message: expect.any(String),
          value: expect.stringMatching(SPREADSHEET_ERROR),
        };
        expect(at("A1")).toEqual(anError);
        expect(at("A2")).toEqual({ ...anError, value: "#DIV/0!" });
        expect(at("A3")).toEqual(anError);
        expect(at("A4")).toEqual({ ...anError, value: "#REF!" });
      });
      expect(
        values({
          A1: "=1/0",
          A2: "=A1+1",
          A3: "=SUM(A1,2)",
          A4: "=NOSUCHFUNCTION(1)",
        })
      ).toEqual({
        A1: error("#DIV/0!"),
        A2: error("#DIV/0!"),
        A3: error("#DIV/0!"),
        A4: error("#NAME?"),
      });
    });

    it("answers each calculation for its own snapshot", () => {
      const engine = makeEngine();
      const first = engine.calculate(
        frozen([{ cells: { A1: "1", B1: "=A1*10" }, name: "Sheet1" }])
      );
      const second = engine.calculate(
        frozen([{ cells: { A1: "2", B1: "=A1*10" }, name: "Sheet1" }])
      );
      const B1 = { cell: "B1", sheet: "Sheet1" };
      expect(first.value(B1)).toEqual({ kind: "number", value: 10 });
      expect(second.value(B1)).toEqual({ kind: "number", value: 20 });
      second.close();
      expect(first.value(B1)).toEqual({ kind: "number", value: 10 });
      first.close();
      // Closing twice is allowed.
      first.close();
    });

    it("rewrites only the formulas that refer to a renamed sheet, quoting the new name", () => {
      const sheets = frozen([
        {
          cells: { A1: "4", A2: "=Inputs!A1+1", B1: "=sum( A1 , 1 )" },
          name: "Inputs",
        },
        {
          cells: {
            A1: "=Inputs!A1*10",
            A2: "=inputs!A1+A1",
            A3: "=sum( 2 , 3 )",
            A4: "=Missing!A1",
          },
          name: "Totals",
        },
      ]);
      const { renamed, rewrites } = afterRename(sheets, "Inputs", "My Inputs");
      expect(rewrites.map(({ reference }) => reference)).toEqual(
        expect.arrayContaining([
          { cell: "A2", sheet: "My Inputs" },
          { cell: "A1", sheet: "Totals" },
          { cell: "A2", sheet: "Totals" },
        ])
      );
      expect(rewrites).toHaveLength(3);
      for (const { contents } of rewrites) {
        expect(contents).toContain("'My Inputs'!");
      }
      expect(renamed[0]?.cells.B1).toBe("=sum( A1 , 1 )");
      expect(renamed[1]?.cells.A3).toBe("=sum( 2 , 3 )");
      expect(renamed[1]?.cells.A4).toBe("=Missing!A1");
      calculated(renamed, (calculation) => {
        expect(calculation.value({ cell: "A2", sheet: "My Inputs" })).toEqual({
          kind: "number",
          value: 5,
        });
        expect(calculation.value({ cell: "A1", sheet: "Totals" })).toEqual({
          kind: "number",
          value: 40,
        });
        expect(calculation.value({ cell: "A2", sheet: "Totals" })).toEqual({
          kind: "number",
          value: 44,
        });
      });
    });

    it("drops quotes a renamed sheet no longer needs and follows a change of case", () => {
      const sheets = frozen([
        { cells: { A1: "7" }, name: "My Data" },
        { cells: { A1: "='My Data'!A1*2" }, name: "Totals" },
      ]);
      const plain = afterRename(sheets, "My Data", "Data");
      expect(plain.renamed[1]?.cells.A1).toContain("Data!A1");
      expect(plain.renamed[1]?.cells.A1).not.toContain("'");

      const recased = afterRename(plain.renamed, "Data", "DATA");
      calculated(recased.renamed, (calculation) => {
        expect(calculation.value({ cell: "A1", sheet: "Totals" })).toEqual({
          kind: "number",
          value: 14,
        });
      });
    });

    it("renames without touching the snapshot or calculations built from it", () => {
      const sheets = frozen([
        { cells: { A1: "3" }, name: "Inputs" },
        { cells: { A1: "=Inputs!A1*2" }, name: "Totals" },
      ]);
      const before = JSON.stringify(sheets);
      const engine = makeEngine();
      const calculation = engine.calculate(sheets);
      engine.renameSheetReferences(sheets, "Inputs", "Renamed");
      expect(JSON.stringify(sheets)).toBe(before);
      expect(calculation.value({ cell: "A1", sheet: "Totals" })).toEqual({
        kind: "number",
        value: 6,
      });
      calculation.close();
    });
  });
}
