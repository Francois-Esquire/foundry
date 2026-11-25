import { resolve } from "node:path";
import {
  assertWebStandardExports,
  portableSubpaths,
} from "@foundry/lib/testing/seam";
import { expect, it } from "vitest";

const PACKAGE_DIR = resolve(import.meta.dirname, "../..");

it("loads no node:* imports, ./node adapters, or unguarded Node/Bun globals from any portable subpath", () => {
  expect(() =>
    assertWebStandardExports(PACKAGE_DIR, portableSubpaths(PACKAGE_DIR))
  ).not.toThrow();
});
