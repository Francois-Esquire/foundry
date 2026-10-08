import { z } from "zod";

export const MODULE_MANIFEST_SOURCE_PATH = "foundry.module.json";
export const PORTABLE_SCHEMA_DIALECT = "foundry.schema/json-schema-2020-12@1";

const semverExpression =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** One owner-namespaced Capability name, such as `platform.fetch`. */
export const CAPABILITY_NAME_PATTERN =
  /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;

/** The one spelling of a Capability's `name@version` identity. */
export function capabilityIdentity(
  capability: string,
  version: number
): string {
  return `${capability}@${version}`;
}

/** Every Module-declared path is relative, separator-safe, and traversal-free. */
export function isPortableRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every(
        (segment) => segment.length > 0 && segment !== "." && segment !== ".."
      )
  );
}

const portablePathSchema = z
  .string()
  .min(1)
  .refine(isPortableRelativePath, "must be a portable relative path");

const outputPathSchema = portablePathSchema.refine(
  (path) => path.startsWith("outputs/"),
  "must point inside released outputs"
);

const viewPathSchema = z
  .string()
  .regex(/^\/(?:[^/?#]+(?:\/[^/?#]+)*)?$/, "must be an absolute route");

const jsonLiteralSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const portableSchemaSchema: z.ZodType<PortableSchema> = z.lazy(() =>
  z
    .object({
      $schema: z.literal(PORTABLE_SCHEMA_DIALECT),
      additionalProperties: z.boolean().optional(),
      description: z.string().min(1).optional(),
      enum: z.array(jsonLiteralSchema).min(1).optional(),
      items: portableSchemaSchema.optional(),
      properties: z.record(z.string().min(1), portableSchemaSchema).optional(),
      required: z.array(z.string().min(1)).optional(),
      type: z
        .enum([
          "array",
          "boolean",
          "integer",
          "null",
          "number",
          "object",
          "string",
        ])
        .optional(),
    })
    .strict()
    .superRefine((schema, context) => {
      if (
        schema.required?.some((name) => schema.properties?.[name] === undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "required properties must be declared in properties",
          path: ["required"],
        });
      }
      if (schema.properties !== undefined && schema.type !== "object") {
        context.addIssue({
          code: "custom",
          message: "properties require type object",
          path: ["properties"],
        });
      }
      if (schema.items !== undefined && schema.type !== "array") {
        context.addIssue({
          code: "custom",
          message: "items require type array",
          path: ["items"],
        });
      }
    })
);

export interface PortableSchema {
  readonly $schema: typeof PORTABLE_SCHEMA_DIALECT;
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

const capabilityRequestSchema = z
  .object({
    alias: z.string().regex(/^[a-z][a-z0-9-]*$/),
    capability: z.string().regex(CAPABILITY_NAME_PATTERN),
    constraints: z.unknown().optional(),
    reason: z.string().min(1),
    required: z.boolean().default(false),
    version: z.number().int().positive(),
  })
  .strict();

export const moduleManifestSchema = z
  .object({
    capabilities: z.array(capabilityRequestSchema),
    compatibility: z
      .object({
        gateway: z.literal("1"),
        runtime: z.literal("bun@1"),
      })
      .strict(),
    data: z
      .object({
        migrations: outputPathSchema.optional(),
        protocol: z.literal("drizzle-sqlite@1"),
        schema: outputPathSchema.optional(),
      })
      .strict()
      .optional(),
    format: z.literal("foundry.module/1"),
    program: z
      .object({
        entry: outputPathSchema,
      })
      .strict(),
    views: z.record(
      z.string().regex(/^[a-z][a-z0-9-]*$/),
      z
        .object({
          path: viewPathSchema,
          title: z.string().min(1).optional(),
        })
        .strict()
    ),
  })
  .strict()
  .superRefine((manifest, context) => {
    const aliases = new Set<string>();
    for (const [index, request] of manifest.capabilities.entries()) {
      if (aliases.has(request.alias)) {
        context.addIssue({
          code: "custom",
          message: `capability alias ${JSON.stringify(request.alias)} is duplicated`,
          path: ["capabilities", index, "alias"],
        });
      }
      aliases.add(request.alias);
    }
  });

export type ModuleManifest = z.output<typeof moduleManifestSchema>;
export type ModuleManifestSource = z.input<typeof moduleManifestSchema>;
export type ModuleCapabilityRequest = ModuleManifest["capabilities"][number];

export class ModuleManifestValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleManifestValidationError";
  }
}

export function parseModuleManifest(input: unknown): ModuleManifest {
  const result = moduleManifestSchema.safeParse(input);
  if (!result.success) {
    throw new ModuleManifestValidationError(
      `invalid Module Manifest: ${result.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; ")}`
    );
  }
  return normalizeModuleManifest(result.data);
}

/** Parses editable `foundry.module.json` text without evaluating workspace code. */
export function parseModuleManifestSourceText(text: string): ModuleManifest {
  try {
    return parseModuleManifest(JSON.parse(text));
  } catch (error) {
    if (error instanceof ModuleManifestValidationError) {
      throw error;
    }
    throw new ModuleManifestValidationError(
      "invalid foundry.module.json: source must contain valid JSON",
      { cause: error }
    );
  }
}

/** Validates the portable JSON Schema dialect used for generated Gateway code. */
export function parsePortableSchema(input: unknown): PortableSchema {
  const result = portableSchemaSchema.safeParse(input);
  if (!result.success) {
    throw new ModuleManifestValidationError(
      `invalid portable schema: ${result.error.issues.map((issue) => `${issue.path.join(".") || "schema"}: ${issue.message}`).join("; ")}`
    );
  }
  return deepFreeze(result.data);
}

/**
 * Release-build validation: all Manifest paths resolve in this exact immutable
 * Content tree and each selected capability exists in the build's catalog.
 */
export function validateModuleManifestBuild(input: {
  readonly manifest: unknown;
  /** every path the build's Content will hold */
  readonly paths: Iterable<string>;
  readonly capabilities: readonly {
    readonly capability: string;
    readonly version: number;
  }[];
}): ModuleManifest {
  const manifest = parseModuleManifest(input.manifest);
  assertModuleManifestPaths(manifest, input.paths);
  const catalog = new Set(
    input.capabilities.map((capability) =>
      capabilityIdentity(capability.capability, capability.version)
    )
  );
  for (const request of manifest.capabilities) {
    const identity = capabilityIdentity(request.capability, request.version);
    if (!catalog.has(identity)) {
      throw new ModuleManifestValidationError(
        `Module Manifest selects unavailable capability ${identity}`
      );
    }
  }
  return manifest;
}

/** Every declared output must be one of the paths being bound. */
export function assertModuleManifestPaths(
  manifest: ModuleManifest,
  paths: Iterable<string>
): void {
  const present = new Set(paths);
  for (const path of moduleManifestPaths(manifest)) {
    if (!present.has(path)) {
      throw new ModuleManifestValidationError(
        `Module Manifest path ${JSON.stringify(path)} is absent from the Content tree`
      );
    }
  }
}

export function assertSemverTag(tag: string): void {
  if (!semverExpression.test(tag)) {
    throw new ModuleManifestValidationError(
      `invalid Module Release SemVer tag ${JSON.stringify(tag)}`
    );
  }
}

function normalizeModuleManifest(manifest: ModuleManifest): ModuleManifest {
  const views = Object.fromEntries(
    Object.entries(manifest.views)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, view]) => [name, Object.freeze({ ...view })])
  );
  const capabilities = [...manifest.capabilities]
    .sort((left, right) => left.alias.localeCompare(right.alias))
    .map((capability) => Object.freeze({ ...capability }));
  return deepFreeze({
    ...manifest,
    capabilities,
    compatibility: { ...manifest.compatibility },
    program: { ...manifest.program },
    views,
    ...(manifest.data === undefined ? {} : { data: { ...manifest.data } }),
  });
}

function moduleManifestPaths(manifest: ModuleManifest): readonly string[] {
  return [
    manifest.program.entry,
    ...(manifest.data?.schema === undefined ? [] : [manifest.data.schema]),
    ...(manifest.data?.migrations === undefined
      ? []
      : [manifest.data.migrations]),
  ];
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
