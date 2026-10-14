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
  // Whole segments only.
  ["packages/co", "packages/core"],
  ["packages/co", "packages/core/src/ids.ts#InvoiceId"],
  ["packages/core/src/ids", "packages/core/src/ids.ts"],
  // `#` ends the path: a symbol facet names one symbol and nothing below it.
  ["packages/core/src/ids.ts#Invoice", "packages/core/src/ids.ts#InvoiceId"],
  ["packages/core/src/ids.ts#InvoiceId", "packages/core/src/ids.ts"],
  // Coverage runs downward only.
  ["packages/core/src", "packages/core"],
  // Exactly as written, case included.
  ["packages/Core", "packages/core"],
])("%s does not cover %s", (facet, place) => {
  expect(covers(facet, place)).toBe(false);
});

it.each([
  // Devanagari "kṣa" written with a zero-width joiner after the virama.
  "src/names.ts#\u0915\u094D\u200D\u0937",
  // Persian "mi-khaham" with a zero-width non-joiner between its parts.
  "src/names.ts#\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
])("accepts a symbol name that holds a joiner or non-joiner: %j", (facet) => {
  expect(facetSchema.safeParse(facet).success).toBe(true);
});
