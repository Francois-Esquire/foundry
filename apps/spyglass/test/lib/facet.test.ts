import { expect, it } from "vitest";
import { facetSchema } from "../../src/lib/facet";
import { covers } from "../../src/lib/facet-cover";

it.each([
  ["packages/core", "packages/core"],
  ["packages/core", "packages/core/src/ids.ts"],
  ["packages/core", "packages/core/src/ids.ts#InvoiceId"],
  ["packages/core/src/ids.ts", "packages/core/src/ids.ts#InvoiceId"],
  ["packages/core/src/ids.ts#InvoiceId", "packages/core/src/ids.ts#InvoiceId"],
])("%s covers %s", (facet, place) => {
  expect(covers(facet, place)).toBe(true);
});

it.each([
  ["packages/co", "packages/core"],
  ["packages/co", "packages/core/src/ids.ts#InvoiceId"],
  ["packages/core/src/ids", "packages/core/src/ids.ts"],
  ["packages/core/src/ids.ts#Invoice", "packages/core/src/ids.ts#InvoiceId"],
  ["packages/core/src/ids.ts#InvoiceId", "packages/core/src/ids.ts"],
  ["packages/core/src", "packages/core"],
  ["packages/Core", "packages/core"],
])("%s does not cover %s", (facet, place) => {
  expect(covers(facet, place)).toBe(false);
});

it.each([
  "src/names.ts#\u0915\u094D\u200D\u0937",
  "src/names.ts#\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
])("accepts a symbol name that holds a joiner or non-joiner: %j", (facet) => {
  expect(facetSchema.safeParse(facet).success).toBe(true);
});
