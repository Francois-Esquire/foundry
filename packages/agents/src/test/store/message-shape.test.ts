import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { messageMetadataSchema, sessionPartSchema } from "../../schema";
import { shapeFieldNames } from "../../store/message-shape";

/** A Zod object's field names, required and optional, `type` aside. */
function zodFieldNames(shape: Readonly<Record<string, z.ZodType>>) {
  const names = Object.entries(shape).filter(([name]) => name !== "type");
  const required = names
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([name]) => name)
    .sort();
  const optional = names
    .filter(([, field]) => field.safeParse(undefined).success)
    .map(([name]) => name)
    .sort();
  return { optional, required };
}

describe("the zod-free message shape", () => {
  it("knows each part type, and each part's required and optional fields, as the schema does", () => {
    const schema = Object.fromEntries(
      sessionPartSchema.options.map((variant) => [
        variant.shape.type.value,
        zodFieldNames(variant.shape),
      ])
    );

    expect(shapeFieldNames().parts).toEqual(schema);
  });

  it("knows each metadata field, as the schema does", () => {
    expect(shapeFieldNames().metadata).toEqual(
      zodFieldNames(messageMetadataSchema.shape)
    );
  });
});
