import { z } from "zod";
import { positionOf } from "./address";
import { WorkbookError } from "./errors";

export const WORKBOOK_FORMAT = "foundry.workbook/1";
export const WORKBOOK_MIME = "application/vnd.foundry.workbook+json";
export const WORKBOOK_MAX_BYTES = 1_000_000;

const FORMAT_VERSION = /^foundry\.workbook\/(\d+)$/;
const CURRENT_VERSION = 1;

export interface SavedSheet {
  readonly cells: Readonly<Record<string, string>>;
  readonly name: string;
}

const fileSchema = z
  .object({
    format: z.literal(WORKBOOK_FORMAT),
    sheets: z
      .array(
        z
          .object({
            cells: z.record(z.string(), z.string().min(1)),
            name: z.string(),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

function formatVersion(json: unknown): number | null {
  const format =
    typeof json === "object" && json !== null && "format" in json
      ? json.format
      : null;
  const match = typeof format === "string" ? FORMAT_VERSION.exec(format) : null;
  return match ? Number(match[1]) : null;
}

export function parseWorkbookFile(text: string): readonly SavedSheet[] {
  if (utf8Bytes(text) > WORKBOOK_MAX_BYTES) {
    throw new WorkbookError("This workbook file is too large", {
      code: "too-large",
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new WorkbookError("This file is not JSON", {
      cause: error,
      code: "invalid-file",
    });
  }
  if ((formatVersion(json) ?? 0) > CURRENT_VERSION) {
    throw new WorkbookError("A newer version of Sheets saved this workbook", {
      code: "newer-format",
    });
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new WorkbookError(
      `This file is not a workbook: ${z.prettifyError(parsed.error)}`,
      { code: "invalid-file" }
    );
  }
  return parsed.data.sheets;
}

export function formatWorkbookFile(sheets: readonly SavedSheet[]): string {
  const ordered = sheets.map((sheet) => ({
    cells: Object.fromEntries(
      Object.entries(sheet.cells).sort(([a], [b]) => {
        const left = positionOf(a);
        const right = positionOf(b);
        return left.row - right.row || left.column - right.column;
      })
    ),
    name: sheet.name,
  }));
  const text = `${JSON.stringify({ format: WORKBOOK_FORMAT, sheets: ordered }, null, 2)}\n`;
  if (utf8Bytes(JSON.stringify(text)) > WORKBOOK_MAX_BYTES) {
    throw new WorkbookError(
      "This workbook is larger than Sheets can save: its file would take more than 1,000,000 bytes to send",
      { code: "too-large" }
    );
  }
  return text;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
