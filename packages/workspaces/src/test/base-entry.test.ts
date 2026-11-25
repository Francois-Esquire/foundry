import { resolve } from "node:path";
import { assertWebStandardExports } from "@foundry/lib/testing/seam";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = resolve(import.meta.dirname, "../..");

describe("@foundry/workspaces portable export seam", () => {
  it("loads no node:* imports, ./node adapters, or unguarded Node/Bun globals from portable subpaths", () => {
    expect(() =>
      assertWebStandardExports(PACKAGE_DIR, [".", "./store", "./store/memory"])
    ).not.toThrow();
  });
});
