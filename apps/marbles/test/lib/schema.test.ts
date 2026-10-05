import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  fieldsFromSchema,
  inputFromFields,
  inputKeysOf,
  JSON_FIELD,
  SchemaError,
  validate,
} from "~/lib/schema";

const TYPED_INPUT_ISSUE = /typed input: n: /;

describe("validate", () => {
  it("returns the parsed value with defaults applied", async () => {
    const schema = z.object({ target: z.string().default(".") });
    await expect(validate(schema, {}, "review input")).resolves.toEqual({
      target: ".",
    });
  });

  it("throws a SchemaError naming the place and the path", async () => {
    const schema = z.object({ n: z.number() });
    await expect(validate(schema, { n: "x" }, "typed input")).rejects.toThrow(
      SchemaError
    );
    await expect(validate(schema, { n: "x" }, "typed input")).rejects.toThrow(
      TYPED_INPUT_ISSUE
    );
  });
});

describe("fieldsFromSchema", () => {
  it("maps a flat object of scalars and enums", () => {
    const schema = z.object({
      count: z.number().min(1).max(9).default(3),
      dryRun: z.boolean(),
      notes: z.string().max(500).optional(),
      region: z.enum(["us", "eu"]),
      target: z.string().describe("Where to look"),
    });
    expect(fieldsFromSchema(schema)).toEqual([
      {
        default: 3,
        label: "Count",
        max: 9,
        min: 1,
        name: "count",
        type: "number",
      },
      { label: "Dry run", name: "dryRun", required: true, type: "boolean" },
      { label: "Notes", name: "notes", type: "multiline" },
      {
        label: "Region",
        name: "region",
        options: [
          { label: "us", value: "us" },
          { label: "eu", value: "eu" },
        ],
        required: true,
        type: "select",
      },
      {
        description: "Where to look",
        label: "Target",
        name: "target",
        required: true,
        type: "text",
      },
    ]);
  });

  it("falls back to one JSON field for nested shapes", () => {
    const schema = z.object({ items: z.array(z.string()) });
    expect(fieldsFromSchema(schema)).toEqual([
      {
        label: "Input (JSON)",
        name: JSON_FIELD,
        required: true,
        type: "multiline",
      },
    ]);
  });

  it("returns undefined when the schema exposes no JSON Schema", () => {
    const bare = {
      "~standard": {
        validate: (value: unknown) => ({ value }),
        vendor: "test",
        version: 1 as const,
      },
    };
    expect(fieldsFromSchema(bare)).toBeUndefined();
    expect(inputKeysOf(bare)).toBeUndefined();
  });
});

describe("inputKeysOf and inputFromFields", () => {
  it("lists top-level keys", () => {
    expect(inputKeysOf(z.object({ a: z.string(), b: z.number() }))).toEqual([
      "a",
      "b",
    ]);
  });

  it("parses the JSON field back into an object", () => {
    expect(inputFromFields({ [JSON_FIELD]: '{"items":["x"]}' })).toEqual({
      items: ["x"],
    });
    expect(inputFromFields({ [JSON_FIELD]: "  " })).toEqual({});
    expect(inputFromFields({ a: "1" })).toEqual({ a: "1" });
  });
});
