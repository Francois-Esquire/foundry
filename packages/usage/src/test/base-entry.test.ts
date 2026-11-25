import { resolve } from "node:path";
import { assertWebStandardExports } from "@foundry/lib/testing/seam";
import { expect, it } from "vitest";

const PACKAGE_DIR = resolve(import.meta.dirname, "../..");

it("loads no node:* imports, ./node adapters, or unguarded Node/Bun globals from the base entry", () => {
  expect(() => assertWebStandardExports(PACKAGE_DIR, ["."])).not.toThrow();
});
