export const MODULE_GATEWAY_GENERATED_PATH =
  "packages/module-sdk/generated/gateway.ts";

const ALIAS_PATTERN = /^[a-z][a-z0-9-]*$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;

export interface GatewayCatalog {
  readonly capabilities: readonly GatewayCapability[];
  readonly generation: number;
}

export interface GatewayCapability {
  readonly capability: string;
  readonly event?: PortableSchema;
  readonly input: PortableSchema;
  readonly mode: "unary" | "stream";
  readonly output?: PortableSchema;
  readonly version: number;
}

export interface PortableSchema {
  readonly $schema: "foundry.schema/json-schema-2020-12@1";
  readonly additionalProperties?: boolean;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly items?: PortableSchema;
  readonly properties?: Readonly<Record<string, PortableSchema>>;
  readonly required?: readonly string[];
  readonly type?:
    | "array"
    | "boolean"
    | "integer"
    | "null"
    | "number"
    | "object"
    | "string";
}

export class GatewayGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayGenerationError";
  }
}

export function generateModuleGatewayClient(input: {
  readonly manifest: unknown;
  readonly catalog: GatewayCatalog;
}): string {
  const manifest = manifestSelections(input.manifest);
  const catalog = catalogByIdentity(input.catalog);
  const selected = manifest.map((selection) => {
    const identity = `${selection.capability}@${selection.version}`;
    const descriptor = catalog.get(identity);
    if (descriptor === undefined) {
      throw new GatewayGenerationError(
        `Cannot generate alias ${JSON.stringify(selection.alias)}: selected capability ${identity} is not available in the development catalog`
      );
    }
    return { alias: selection.alias, descriptor };
  });

  return [
    "/* This file is generated from foundry.module.json and the host development catalog. */",
    'import type { GatewayClient } from "@foundry/module-sdk";',
    "",
    "export interface ModuleGateway {",
    ...selected.flatMap(({ alias, descriptor }) => member(alias, descriptor)),
    "}",
    "",
    "export function bindModuleGateway(client: GatewayClient): ModuleGateway {",
    "  return Object.freeze({",
    ...selected.map(({ alias, descriptor }) => binding(alias, descriptor)),
    "  });",
    "}",
    "",
  ].join("\n");
}

function catalogByIdentity(
  catalog: GatewayCatalog
): ReadonlyMap<string, GatewayCapability> {
  if (!Number.isSafeInteger(catalog.generation) || catalog.generation < 0) {
    throw new GatewayGenerationError(
      "Development catalog generation must be a non-negative safe integer"
    );
  }
  const indexed = new Map<string, GatewayCapability>();
  for (const descriptor of catalog.capabilities) {
    assertDescriptor(descriptor);
    const identity = `${descriptor.capability}@${descriptor.version}`;
    if (indexed.has(identity)) {
      throw new GatewayGenerationError(
        `Development catalog contains duplicate capability ${identity}`
      );
    }
    indexed.set(identity, descriptor);
  }
  return indexed;
}

function manifestSelections(value: unknown): readonly Selection[] {
  if (!(record(value) && Array.isArray(value.capabilities))) {
    throw new GatewayGenerationError(
      "foundry.module.json must contain a capabilities array"
    );
  }
  const aliases = new Set<string>();
  const selections = value.capabilities.map((entry, index) => {
    if (
      !record(entry) ||
      typeof entry.alias !== "string" ||
      !ALIAS_PATTERN.test(entry.alias) ||
      typeof entry.capability !== "string" ||
      !CAPABILITY_PATTERN.test(entry.capability) ||
      typeof entry.version !== "number" ||
      !Number.isSafeInteger(entry.version) ||
      entry.version < 1
    ) {
      throw new GatewayGenerationError(
        `foundry.module.json capability at index ${index} is invalid`
      );
    }
    if (aliases.has(entry.alias)) {
      throw new GatewayGenerationError(
        `foundry.module.json capability alias ${JSON.stringify(entry.alias)} is duplicated`
      );
    }
    aliases.add(entry.alias);
    return {
      alias: entry.alias,
      capability: entry.capability,
      version: entry.version,
    };
  });
  return selections.sort((left, right) =>
    left.alias.localeCompare(right.alias)
  );
}

interface Selection {
  readonly alias: string;
  readonly capability: string;
  readonly version: number;
}

function assertDescriptor(value: GatewayCapability): void {
  if (
    !(
      CAPABILITY_PATTERN.test(value.capability) &&
      Number.isSafeInteger(value.version)
    ) ||
    value.version < 1
  ) {
    throw new GatewayGenerationError(
      "Development catalog contains an invalid capability identity"
    );
  }
  schema(value.input);
  if (value.mode === "unary") {
    schema(value.output);
  } else {
    schema(value.event);
  }
}

const schemaMembers = [
  "$schema",
  "type",
  "description",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
];
const schemaTypes = [
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
];

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: A flat list of independent portable-schema checks; this text ships verbatim in the Module SDK.
function schema(value: unknown): asserts value is PortableSchema {
  if (
    !record(value) ||
    value.$schema !== "foundry.schema/json-schema-2020-12@1"
  ) {
    throw new GatewayGenerationError(
      "Development catalog has an incompatible portable schema dialect"
    );
  }
  for (const key of Object.keys(value)) {
    if (!schemaMembers.includes(key)) {
      throw new GatewayGenerationError(
        `Development catalog portable schema has an unsupported member ${JSON.stringify(key)}`
      );
    }
  }
  if (
    value.type !== undefined &&
    (typeof value.type !== "string" || !schemaTypes.includes(value.type))
  ) {
    throw new GatewayGenerationError(
      "Development catalog portable schema has an unsupported type"
    );
  }
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" || value.description.length === 0)
  ) {
    throw new GatewayGenerationError(
      "Development catalog portable schema has an invalid description"
    );
  }
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) ||
      value.enum.length === 0 ||
      !value.enum.every(jsonLiteral))
  ) {
    throw new GatewayGenerationError(
      "Development catalog portable schema has an invalid enum"
    );
  }
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== "boolean"
  ) {
    throw new GatewayGenerationError(
      "Development catalog portable schema has an invalid additionalProperties"
    );
  }
  const { properties } = value;
  if (properties !== undefined) {
    if (!record(properties) || value.type !== "object") {
      throw new GatewayGenerationError(
        "Development catalog has an invalid portable object schema"
      );
    }
    for (const property of Object.values(properties)) {
      schema(property);
    }
  }
  const { required } = value;
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      throw new GatewayGenerationError(
        "Development catalog portable schema has invalid required properties"
      );
    }
    for (const name of required) {
      if (
        typeof name !== "string" ||
        name.length === 0 ||
        !record(properties) ||
        properties[name] === undefined
      ) {
        throw new GatewayGenerationError(
          "Development catalog portable schema has invalid required properties"
        );
      }
    }
  }
  const { items } = value;
  if (items !== undefined) {
    if (value.type !== "array") {
      throw new GatewayGenerationError(
        "Development catalog has an invalid portable array schema"
      );
    }
    schema(items);
  }
}

function jsonLiteral(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function member(
  alias: string,
  descriptor: GatewayCapability
): readonly string[] {
  const input = type(descriptor.input);
  if (descriptor.mode === "unary") {
    return [
      `  readonly ${alias}: {`,
      `    call(input: ${input}, options?: { signal?: AbortSignal }): Promise<${type(descriptor.output)}>;`,
      "  };",
    ];
  }
  return [
    `  readonly ${alias}: {`,
    `    observe(input: ${input}, options?: { signal?: AbortSignal }): AsyncIterable<${type(descriptor.event)}>;`,
    "  };",
  ];
}

function binding(alias: string, descriptor: GatewayCapability): string {
  const input = type(descriptor.input);
  if (descriptor.mode === "unary") {
    return `    ${alias}: Object.freeze({ call: (input: ${input}, options?: { signal?: AbortSignal }) => client.call(${JSON.stringify(alias)}, input, options) as Promise<${type(descriptor.output)}> }),`;
  }
  return `    ${alias}: Object.freeze({ observe: (input: ${input}, options?: { signal?: AbortSignal }) => client.observe(${JSON.stringify(alias)}, input, options) as AsyncIterable<${type(descriptor.event)}> }),`;
}

function type(value: PortableSchema | undefined): string {
  if (value === undefined) {
    throw new GatewayGenerationError(
      "Development catalog capability is missing its result schema"
    );
  }
  schema(value);
  if (value.enum !== undefined) {
    return value.enum.map((item) => JSON.stringify(item)).join(" | ");
  }
  if (value.type === "string") {
    return "string";
  }
  if (value.type === "number" || value.type === "integer") {
    return "number";
  }
  if (value.type === "boolean") {
    return "boolean";
  }
  if (value.type === "null") {
    return "null";
  }
  if (value.type === "array") {
    return `ReadonlyArray<${value.items === undefined ? "unknown" : type(value.items)}>`;
  }
  if (value.type !== "object") {
    return "unknown";
  }
  const required = new Set(value.required);
  const members = Object.entries(value.properties ?? {}).map(
    ([key, property]) =>
      `readonly ${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${type(property)};`
  );
  if (value.additionalProperties === true) {
    members.push("readonly [key: string]: unknown;");
  }
  return members.length === 0
    ? "Record<string, never>"
    : `{ ${members.join(" ")} }`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
