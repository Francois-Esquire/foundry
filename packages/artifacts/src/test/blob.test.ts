import { describe, expect, test } from "vitest";

import type { Blob } from "../blob";
import { validateBlob } from "../blob";
import { blobIdSchema } from "../ref";

const id = blobIdSchema.parse("blob");
const valid = {
  byteLength: 1,
  bytes: new Uint8Array(1),
  createdAt: new Date(0),
  digest: "a".repeat(64),
  id,
} as const;

function blob(overrides: Record<string, unknown>): Blob {
  return { ...valid, ...overrides } as unknown as Blob;
}

describe("validateBlob", () => {
  test("accepts each single source", () => {
    expect(() => validateBlob(blob({}))).not.toThrow();
    expect(() =>
      validateBlob(blob({ bytes: undefined, path: "blobs/a" }))
    ).not.toThrow();
    expect(() =>
      validateBlob(
        blob({ bytes: undefined, chunks: [blobIdSchema.parse("leaf")] })
      )
    ).not.toThrow();
  });

  test.each([
    ["an empty id", { id: "" }, "Invalid blob: "],
    ["two sources", { path: "blobs/a" }, "Invalid blob: blob"],
    ["no source", { bytes: undefined }, "Invalid blob: blob"],
    ["a malformed digest", { digest: "A".repeat(64) }, "Invalid blob: blob"],
    ["a negative byte length", { byteLength: -1 }, "Invalid blob: blob"],
    ["a fractional byte length", { byteLength: 1.5 }, "Invalid blob: blob"],
    ["mismatched inline bytes", { byteLength: 2 }, "Blob size mismatch: blob"],
    [
      "an empty path",
      { bytes: undefined, path: "" },
      "Invalid blob path: blob",
    ],
    [
      "a path with NUL",
      { bytes: undefined, path: "a\0b" },
      "Invalid blob path: blob",
    ],
    [
      "no chunks",
      { bytes: undefined, chunks: [] },
      "Invalid blob chunks: blob",
    ],
    [
      "a chunk naming itself",
      { bytes: undefined, chunks: [id] },
      "Invalid blob chunks: blob",
    ],
  ])("refuses %s with the existing message", (_, overrides, message) => {
    expect(() => validateBlob(blob(overrides))).toThrow(new Error(message));
  });
});
