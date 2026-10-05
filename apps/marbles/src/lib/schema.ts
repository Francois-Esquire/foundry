import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";

import type { InputField } from "~/lib/inputs";

/**
 * Schemas are any Standard Schema. Validation and types need only that; the
 * launch form and the catalog need the library's Standard JSON Schema too,
 * and degrade to one JSON field without it.
 */

export type Output<S extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<S>;
/** What a schema accepts before parsing: defaults optional, transforms unapplied. */
export type Input<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;

export class SchemaError extends Error {
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(where: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(`${where}: ${issues.map(describeIssue).join("; ")}`);
    this.name = "SchemaError";
    this.issues = issues;
  }
}

function describeIssue(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? [])
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment)
    )
    .join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Parse `value` through `schema`; throws {@link SchemaError} on issues. */
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  where: string
): Promise<Output<S>> {
  let result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    result = await result;
  }
  if (result.issues) {
    throw new SchemaError(where, result.issues);
  }
  return result.value as Output<S>;
}

/** The input JSON Schema when the library exposes one. */
export function jsonSchemaOf(
  schema: StandardSchemaV1
): Record<string, unknown> | undefined {
  const props = schema["~standard"] as Partial<StandardJSONSchemaV1.Props>;
  const converter = props.jsonSchema;
  if (!converter) {
    return undefined;
  }
  try {
    return converter.input({ target: "draft-2020-12" });
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level property names of an object schema, when knowable. */
export function inputKeysOf(
  schema: StandardSchemaV1
): readonly string[] | undefined {
  const json = jsonSchemaOf(schema);
  if (!(json && json.type === "object" && isRecord(json.properties))) {
    return undefined;
  }
  return Object.keys(json.properties);
}

const MULTILINE_THRESHOLD = 200;

function labelFor(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function scalarDefault(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : undefined;
}

function fieldFrom(
  key: string,
  property: Record<string, unknown>,
  required: boolean
): InputField | undefined {
  const common = {
    ...(typeof property.description === "string"
      ? { description: property.description }
      : {}),
    label: labelFor(key),
    name: key,
    ...(required ? { required: true } : {}),
  };
  const fallback = scalarDefault(property.default);
  const withDefault = fallback === undefined ? {} : { default: fallback };
  if (Array.isArray(property.enum)) {
    const values = property.enum.filter(
      (entry): entry is string => typeof entry === "string"
    );
    if (values.length !== property.enum.length) {
      return undefined;
    }
    return {
      ...common,
      ...withDefault,
      options: values.map((value) => ({ label: value, value })),
      type: "select",
    };
  }
  switch (property.type) {
    case "string": {
      const long =
        typeof property.maxLength === "number" &&
        property.maxLength > MULTILINE_THRESHOLD;
      return {
        ...common,
        ...withDefault,
        type: long || property.format === "multiline" ? "multiline" : "text",
      };
    }
    case "number":
    case "integer":
      return {
        ...common,
        ...withDefault,
        ...(typeof property.maximum === "number"
          ? { max: property.maximum }
          : {}),
        ...(typeof property.minimum === "number"
          ? { min: property.minimum }
          : {}),
        type: "number",
      };
    case "boolean":
      return { ...common, ...withDefault, type: "boolean" };
    default:
      return undefined;
  }
}

export const JSON_FIELD = "$json";

/** The one field a launch form shows when it cannot describe the schema's shape. */
export const JSON_INPUT_FIELD: InputField = {
  label: "Input (JSON)",
  name: JSON_FIELD,
  required: true,
  type: "multiline",
};

/**
 * Launch-form fields for a schema: one per property of a flat object of
 * strings, numbers, booleans, and string enums. Anything else becomes a
 * single JSON field. `undefined` when the schema exposes no JSON Schema;
 * the caller decides what that means, since a schema without a form
 * representation still takes input.
 */
export function fieldsFromSchema(
  schema: StandardSchemaV1
): readonly InputField[] | undefined {
  const json = jsonSchemaOf(schema);
  if (!json) {
    return undefined;
  }
  const jsonField = JSON_INPUT_FIELD;
  if (json.type !== "object" || !isRecord(json.properties)) {
    return [jsonField];
  }
  const required = new Set(
    Array.isArray(json.required)
      ? json.required.filter((key): key is string => typeof key === "string")
      : []
  );
  const fields: InputField[] = [];
  for (const [key, property] of Object.entries(json.properties)) {
    if (!isRecord(property)) {
      return [jsonField];
    }
    const field = fieldFrom(key, property, required.has(key));
    if (!field) {
      return [jsonField];
    }
    fields.push(field);
  }
  return fields;
}

/** Turn launch-form values back into the object a schema validates. */
export function inputFromFields(
  values: Readonly<Record<string, unknown>>
): unknown {
  if (JSON_FIELD in values) {
    const raw = values[JSON_FIELD];
    return typeof raw === "string" && raw.trim() ? JSON.parse(raw) : {};
  }
  return values;
}
