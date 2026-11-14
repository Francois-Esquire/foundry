import { expect, it } from "vitest";
import { WorkbookError } from "../workbook/errors";
import { WORKBOOK_MAX_BYTES } from "../workbook/file";
import { MAX_CONTENTS_LENGTH } from "../workbook/workbook";
import { workbooks as Workbook } from "./helpers/workbooks";

function refusedOpen(text: string): string {
  try {
    Workbook.open(text).close();
  } catch (error) {
    if (error instanceof WorkbookError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("The file opened");
}

const file = (sheets: unknown, format = "foundry.workbook/1") =>
  JSON.stringify({ format, sheets });

it("saves typed contents, not values, and reopens them calculated", () => {
  const workbook = Workbook.create();
  workbook.renameSheet("Sheet1", "Inputs");
  workbook.addSheet("Totals");
  workbook.enter({ cell: "B2", sheet: "Inputs" }, "4");
  workbook.enter({ cell: "A1", sheet: "Inputs" }, "'007");
  workbook.enter({ cell: "A1", sheet: "Totals" }, "=Inputs!B2*10");
  workbook.enter({ cell: "C9", sheet: "Totals" }, "=SUM(");
  const saved = workbook.toFile();
  workbook.close();

  expect(JSON.parse(saved)).toEqual({
    format: "foundry.workbook/1",
    sheets: [
      { cells: { A1: "'007", B2: "4" }, name: "Inputs" },
      { cells: { A1: "=Inputs!B2*10", C9: "=SUM(" }, name: "Totals" },
    ],
  });

  const reopened = Workbook.open(saved);
  expect(reopened.sheets).toEqual(["Inputs", "Totals"]);
  expect(reopened.contents({ cell: "A1", sheet: "Totals" })).toBe(
    "=Inputs!B2*10"
  );
  expect(reopened.value({ cell: "A1", sheet: "Totals" })).toEqual({
    kind: "number",
    value: 40,
  });
  // Reopened, it still recalculates, and saves the same file.
  expect(reopened.toFile()).toBe(saved);
  reopened.enter({ cell: "B2", sheet: "Inputs" }, "6");
  expect(reopened.value({ cell: "A1", sheet: "Totals" })).toEqual({
    kind: "number",
    value: 60,
  });
});

it("saves cells in row order, so the same workbook always saves the same file", () => {
  const workbook = Workbook.create();
  workbook.enter({ cell: "B2", sheet: "Sheet1" }, "2");
  workbook.enter({ cell: "A1", sheet: "Sheet1" }, "1");
  workbook.enter({ cell: "C1", sheet: "Sheet1" }, "3");
  expect(Object.keys(JSON.parse(workbook.toFile()).sheets[0].cells)).toEqual([
    "A1",
    "C1",
    "B2",
  ]);
});

it("opens a formula that refers to a sheet saved after it", () => {
  const workbook = Workbook.open(
    file([
      { cells: { A1: "=Later!A1+1" }, name: "First" },
      { cells: { A1: "41" }, name: "Later" },
    ])
  );
  expect(workbook.value({ cell: "A1", sheet: "First" })).toEqual({
    kind: "number",
    value: 42,
  });
});

it("refuses files that are not version 1 workbooks", () => {
  expect(refusedOpen("not json")).toBe("invalid-file");
  expect(
    refusedOpen(file([{ cells: {}, name: "A" }], "foundry.workbook/2"))
  ).toBe("newer-format");
  expect(refusedOpen(file([{ cells: {}, name: "A" }], "other/1"))).toBe(
    "invalid-file"
  );
  expect(refusedOpen(file([]))).toBe("invalid-file");
  expect(refusedOpen(file([{ cells: { A1: 5 }, name: "A" }]))).toBe(
    "invalid-file"
  );
  expect(refusedOpen(file([{ cells: {}, extra: true, name: "A" }]))).toBe(
    "invalid-file"
  );
});

it("refuses files that break the workbook's rules", () => {
  expect(refusedOpen(file([{ cells: { ZZZ1: "1" }, name: "A" }]))).toBe(
    "invalid-file"
  );
  expect(
    refusedOpen(
      file([
        { cells: {}, name: "Same" },
        { cells: {}, name: "same" },
      ])
    )
  ).toBe("invalid-file");
  expect(refusedOpen(file([{ cells: {}, name: "It's" }]))).toBe("invalid-file");
  expect(refusedOpen(" ".repeat(WORKBOOK_MAX_BYTES + 1))).toBe("too-large");
});

/** UTF-8 bytes of a frame or string as JSON, how the Gateway measures frames. */
const sentBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** The Gateway's frame limit, in both directions. */
const GATEWAY_FRAME_BYTES = 1_048_576;

it("refuses an edit whose file would be too large to send and preserves the prior workbook", () => {
  // Each backslash is 2 bytes in the file and 4 once the file is sent as
  // a JSON string, so this workbook's file is half the limit when refused.
  const workbook = Workbook.create();
  const long = "\\".repeat(30_000);
  for (let row = 1; row <= 8; row += 1) {
    workbook.enter({ cell: `A${String(row)}`, sheet: "Sheet1" }, long);
  }
  const before = workbook.toFile();
  expect(() => workbook.enter({ cell: "A9", sheet: "Sheet1" }, long)).toThrow(
    expect.objectContaining({ code: "too-large" })
  );
  expect(workbook.toFile()).toBe(before);
  expect(workbook.contents({ cell: "A9", sheet: "Sheet1" })).toBe("");
  expect(new TextEncoder().encode(before).byteLength).toBeLessThan(500_000);
  workbook.close();
});

it("refuses to open a file Sheets could not send back", () => {
  const cells = Object.fromEntries(
    Array.from({ length: 9 }, (_, row) => [
      `A${String(row + 1)}`,
      "\\".repeat(30_000),
    ])
  );
  const text = file([{ cells, name: "Sheet1" }]);
  expect(new TextEncoder().encode(text).byteLength).toBeLessThan(
    WORKBOOK_MAX_BYTES
  );
  expect(refusedOpen(text)).toBe("too-large");
});

it("fits every workbook it accepts in the Gateway frames that carry it", () => {
  // Quotes, backslashes and control characters grow when escaped; the rest
  // are multibyte in UTF-8, and slicing splits surrogate pairs too.
  const mixed = '\\"\n\t\u0001\u001fé漢😀'
    .repeat(4000)
    .slice(0, MAX_CONTENTS_LENGTH);
  const workbook = Workbook.create();
  let row = 1;
  for (;;) {
    try {
      workbook.enter({ cell: `A${String(row)}`, sheet: "Sheet1" }, mixed);
    } catch (error) {
      expect(error).toMatchObject({ code: "too-large" });
      break;
    }
    row += 1;
  }
  const text = workbook.toFile();
  workbook.close();
  expect(sentBytes(text)).toBeLessThanOrEqual(WORKBOOK_MAX_BYTES);
  expect(sentBytes(text)).toBeGreaterThan(WORKBOOK_MAX_BYTES - 200_000);

  // Every field at the longest the Gateway or Works' contract allows.
  const id = "i".repeat(256);
  const request = "r".repeat(200);
  const digest = "d".repeat(64);
  const save = {
    alias: "save",
    id,
    input: {
      binding: "b".repeat(256),
      expectedDigest: digest,
      request,
      retry: true,
      text,
    },
    kind: "invoke",
    mode: "unary",
  };
  const create = {
    alias: "create",
    id,
    input: {
      content: text,
      mime: "application/vnd.foundry.workbook+json",
      name: "n".repeat(200),
      path: "p".repeat(512),
      request,
    },
    kind: "invoke",
    mode: "unary",
  };
  // What a lost save gets back when another Sheets editor saved this text.
  const conflict = {
    id,
    kind: "result",
    output: {
      bytes: new TextEncoder().encode(text).byteLength,
      current: {
        bytes: new TextEncoder().encode(text).byteLength,
        digest,
        text,
      },
      digest,
      evidence: "recovery-required",
      kind: "conflict",
      reason: "x".repeat(1024),
      retried: true,
      updatedAt: "2026-11-08T00:00:00.000Z",
    },
  };
  for (const frame of [save, create, conflict]) {
    expect(sentBytes(frame)).toBeLessThanOrEqual(GATEWAY_FRAME_BYTES);
  }
});
