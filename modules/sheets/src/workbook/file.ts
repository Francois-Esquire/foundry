/**
 * The workbook file: what Sheets saves and reopens. A sheet's cells map A1
 * addresses to the contents typed there (formulas and raw values), never to
 * calculated values, so reopening calculates them again. Version 1:
 *
 *     {
 *       "format": "foundry.workbook/1",
 *       "sheets": [{ "name": "Sheet1", "cells": { "A1": "10", "B1": "=A1*2" } }]
 *     }
 *
 * This module checks the file's shape; the Workbook checks its rules
 * (sheet names, addresses, sizes) as it is built from it.
 *
 * Size is measured the way the host carries the file. Every save and create
 * sends it whole as one JSON string inside one Gateway frame of at most
 * 1 MiB (1,048,576 bytes), so a backslash costs 4 bytes there, not 1. The
 * limit applies to the UTF-8 bytes of `JSON.stringify(file)`, which the
 * ECMAScript specification fixes exactly, leaving 48,576 bytes for the
 * frame's other fields (ids, binding, digest; well under 1 KB together).
 */

import { z } from "zod";
import { positionOf } from "./address";
import { WorkbookError } from "./errors";

export const WORKBOOK_FORMAT = "foundry.workbook/1";
export const WORKBOOK_MIME = "application/vnd.foundry.workbook+json";
/**
 * The most a workbook file may take as a JSON string: the UTF-8 bytes of
 * `JSON.stringify(file)`. The file's own bytes are always fewer.
 */
export const WORKBOOK_MAX_BYTES = 1_000_000;

const FORMAT_VERSION = /^foundry\.workbook\/(\d+)$/;
const CURRENT_VERSION = 1;

/** One sheet as saved: its name, and the contents of each non-empty cell. */
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

/** The sheets a workbook file holds; refuses anything but version 1. */
export function parseWorkbookFile(text: string): readonly SavedSheet[] {
  // A cheap first check; the Workbook checks the file it would save.
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

/** The workbook file for these sheets, ending in a newline. */
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
