import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";

import type { InputField } from "~/lib/inputs";
import { isRecord } from "~/lib/json-data";

export type Output<S extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<S>;
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

export const JSON_INPUT_FIELD: InputField = {
  label: "Input (JSON)",
  name: JSON_FIELD,
  required: true,
  type: "multiline",
};

export function fieldsFromJsonSchema(
  json: Readonly<Record<string, unknown>>
): readonly InputField[] {
  if (json.type !== "object" || !isRecord(json.properties)) {
    return [JSON_INPUT_FIELD];
  }
  const required = new Set(
    Array.isArray(json.required)
      ? json.required.filter((key): key is string => typeof key === "string")
      : []
  );
  const fields: InputField[] = [];
  for (const [key, property] of Object.entries(json.properties)) {
    if (!isRecord(property)) {
      return [JSON_INPUT_FIELD];
    }
    const field = fieldFrom(key, property, required.has(key));
    if (!field) {
      return [JSON_INPUT_FIELD];
    }
    fields.push(field);
  }
  return fields;
}

export function inputFromFields(
  values: Readonly<Record<string, unknown>>
): unknown {
  if (JSON_FIELD in values) {
    const raw = values[JSON_FIELD];
    return typeof raw === "string" && raw.trim() ? JSON.parse(raw) : {};
  }
  return values;
}

function kindOf(value: unknown): string | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : String(value);
  }
  if (typeof value !== "object") {
    return `a ${typeof value}`;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    Array.isArray(value) ||
    prototype === Object.prototype ||
    prototype === null
  ) {
    return;
  }
  return `a ${(value as object).constructor?.name ?? "class instance"}`;
}

export function notJson(value: unknown, path = ""): string | undefined {
  const kind = kindOf(value);
  if (kind !== undefined) {
    return `${path || "the result"} is ${kind}`;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const at = Array.isArray(value)
      ? `${path}[${key}]`
      : `${path}${path ? "." : ""}${key}`;
    const found = notJson(item, at);
    if (found) {
      return found;
    }
  }
}
