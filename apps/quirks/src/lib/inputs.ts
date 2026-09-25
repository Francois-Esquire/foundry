export interface InputField {
  readonly default?: string | number | boolean;
  readonly description?: string;
  readonly label: string;
  readonly max?: number;
  readonly min?: number;
  readonly name: string;
  readonly options?: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  readonly required?: boolean;
  readonly type: "text" | "multiline" | "number" | "boolean" | "select";
}

/** Omitted metadata means unknown input; an empty fields list explicitly means no arguments. */
export interface DefinitionOptions {
  readonly description?: string;
  readonly input?: { readonly fields: readonly InputField[] };
}

export type InputValues = Partial<Record<string, string | number | boolean>>;

export function inputDefaults(fields: readonly InputField[]): InputValues {
  return Object.fromEntries(
    fields.flatMap((field) =>
      field.default === undefined ? [] : [[field.name, field.default]]
    )
  );
}

export function inputProblem(
  fields: readonly InputField[]
): string | undefined {
  const names = new Set<string>();
  for (const field of fields) {
    if (
      !field.name ||
      ["__proto__", "constructor", "prototype"].includes(field.name) ||
      names.has(field.name)
    ) {
      return "Argument names must be unique, nonempty, and safe object keys.";
    }
    names.add(field.name);
    if (
      !["text", "multiline", "number", "boolean", "select"].includes(field.type)
    ) {
      return `Unsupported argument type for ${field.label}. Use quirks once with --input.`;
    }
    if (field.type === "select" && !field.options?.length) {
      return `No choices configured for ${field.label}.`;
    }
  }
  return undefined;
}

function parseNumber(
  field: InputField,
  value: string | number | boolean
): { value?: number; error?: string } {
  const number =
    typeof value === "string" && !value.trim() ? Number.NaN : Number(value);
  const outOfRange =
    (field.min !== undefined && number < field.min) ||
    (field.max !== undefined && number > field.max);
  if (typeof value === "boolean" || !Number.isFinite(number) || outOfRange) {
    return {
      error: `Enter a valid number${field.min === undefined ? "" : ` ≥ ${field.min}`}${field.max === undefined ? "" : ` ≤ ${field.max}`}.`,
    };
  }
  return { value: number };
}

function parseField(
  field: InputField,
  value: string | number | boolean | undefined
): { value?: string | number | boolean; error?: string } {
  if (value === undefined || value === "") {
    return field.required ? { error: `${field.label} is required.` } : {};
  }
  if (field.type === "number") {
    return parseNumber(field, value);
  }
  if (field.type === "boolean") {
    return typeof value === "boolean"
      ? { value }
      : { error: "Choose yes or no." };
  }
  if (typeof value !== "string") {
    return { error: `Enter text for ${field.label}.` };
  }
  if (
    field.type === "select" &&
    !field.options?.some((option) => option.value === value)
  ) {
    return { error: `Choose a valid ${field.label}.` };
  }
  return { value };
}

export function parseInputs(
  fields: readonly InputField[],
  values: InputValues
): { readonly input: InputValues; readonly errors: Record<string, string> } {
  const input: InputValues = {};
  const errors: Record<string, string> = {};
  const problem = inputProblem(fields);
  if (problem) {
    return { errors: { configuration: problem }, input };
  }
  for (const field of fields) {
    const parsed = parseField(field, values[field.name]);
    if (parsed.error) {
      errors[field.name] = parsed.error;
    }
    if (parsed.value !== undefined) {
      input[field.name] = parsed.value;
    }
  }
  return { errors, input };
}
