import {
  DESTINATION_PORTS_MAX,
  DNS_HOST_NAME_MAX_LENGTH,
  DNS_HOST_NAME_PATTERN,
  PORT_MAX,
  PORT_MIN,
} from "@foundry/lib/network";
import { byCodeUnit } from "@foundry/lib/ordering";
import { z } from "zod";

import {
  isResourceSettingKey,
  MODULE_SETTING_KEYS,
  type ModuleSettingKey,
  type ModuleSettingRequest,
  type ModuleSettingRequests,
  moduleSettingValueProblem,
  parseModuleSettingKey,
} from "./settings";

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

/** The original Manifest format. Its semantics and frozen bytes never change. */
export const LEGACY_MODULE_MANIFEST_FORMAT = "foundry.module/1";
/** The strict Manifest format: the legacy fields plus the declarations below. */
export const MODULE_MANIFEST_FORMAT = "foundry.module-manifest/1";
export const MODULE_MANIFEST_FORMATS = Object.freeze([
  LEGACY_MODULE_MANIFEST_FORMAT,
  MODULE_MANIFEST_FORMAT,
] as const);

const viewNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

const sharedManifestFields = {
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
  program: z
    .object({
      entry: outputPathSchema,
    })
    .strict(),
  views: z.record(
    viewNameSchema,
    z
      .object({
        path: viewPathSchema,
        title: z.string().min(1).optional(),
      })
      .strict()
  ),
};

const legacyManifestSchema = z
  .object({
    ...sharedManifestFields,
    format: z.literal(LEGACY_MODULE_MANIFEST_FORMAT),
  })
  .strict()
  .superRefine(refineCapabilities);

/** A lowercase `type/subtype` MIME type, as the Manifest spells one. */
export const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

const mimeTypeSchema = z
  .string()
  .regex(MIME_TYPE_PATTERN, "must be a lowercase type/subtype MIME type");

/**
 * One requested destination, in the shape the sandbox destination allowlist
 * takes (`@foundry/sandbox/container/constraints`), so an approved request
 * becomes `network: { mode: "allowlist", destinations }` unchanged.
 */
const networkDestinationSchema = z
  .object({
    host: z
      .string()
      .toLowerCase()
      .regex(DNS_HOST_NAME_PATTERN, "must be a DNS host name")
      .max(DNS_HOST_NAME_MAX_LENGTH),
    ports: z
      .array(z.number().int().min(PORT_MIN).max(PORT_MAX))
      .min(1)
      .max(DESTINATION_PORTS_MAX)
      .optional(),
  })
  .strict();

const settingRequestSchema = z
  .object({
    default: z.number().positive().optional(),
    minimum: z.number().positive().optional(),
  })
  .strict();

const strictManifestSchema = z
  .object({
    ...sharedManifestFields,
    /** Released app editors: an existing View that opens these MIME types. */
    editors: z
      .array(
        z
          .object({
            mimeTypes: z.array(mimeTypeSchema).min(1),
            mode: z.enum(["read", "write"]),
            view: viewNameSchema,
          })
          .strict()
      )
      .optional()
      .meta({
        description:
          "Editors this released app provides: an existing View, the MIME types it opens, and read or write mode. Each View appears once.",
      }),
    format: z.literal(MODULE_MANIFEST_FORMAT),
    /**
     * Requested released-app network access. A request grants nothing: only
     * an approved Grant becomes the Program's destination allowlist.
     */
    network: z
      .object({
        destinations: z.array(networkDestinationSchema).min(1).max(64),
        reason: z.string().min(1),
      })
      .strict()
      .optional()
      .meta({
        description:
          "Requested released-app network destinations. A request grants nothing; only an approved Grant allows access. Approved destinations accept TLS (HTTPS) connections only, on port 443 unless ports are listed.",
      }),
    /** `installation`: private files survive on the durable Installation. */
    persistence: z
      .object({ files: z.enum(["none", "installation"]) })
      .strict()
      .optional()
      .meta({
        description:
          'Private files: "installation" keeps them on the durable Installation (required by data); "none" removes them after a confirmed stop.',
      }),
    /** Requested sandbox capacity: minimums, raised to by host defaults. */
    resources: z
      .object({
        cpus: z.number().positive().optional(),
        memoryBytes: z.number().int().positive().optional(),
        /** A hard private-files limit; refused while no runtime enforces one. */
        storageBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional()
      .meta({
        description:
          "Minimum sandbox capacity. Hosts raise defaults to meet it and refuse what they cannot meet, including any hard storage limit they cannot enforce.",
      }),
    /** Dot-notation setting key → requested `minimum` and/or `default`. */
    settings: z
      .record(z.string(), settingRequestSchema)
      .optional()
      .meta({
        description:
          "Requested minimums and defaults of Module settings by dot-notation key. Settings are limits and preferences; they never grant authority.",
        propertyNames: {
          enum: MODULE_SETTING_KEYS.filter((key) => !isResourceSettingKey(key)),
        },
      }),
  })
  .strict()
  .superRefine((manifest, context) => {
    refineCapabilities(manifest, context);
    refineOneRequestPerCapability(manifest, context);
    refineStrictManifest(manifest, context);
  });

export const moduleManifestSchema = z.discriminatedUnion("format", [
  legacyManifestSchema,
  strictManifestSchema,
]);

export type ModuleManifest = z.output<typeof moduleManifestSchema>;
export type ModuleManifestSource = z.input<typeof moduleManifestSchema>;
export type StrictModuleManifest = z.output<typeof strictManifestSchema>;
export type ModuleCapabilityRequest = ModuleManifest["capabilities"][number];
export type ModuleEditorDeclaration = NonNullable<
  StrictModuleManifest["editors"]
>[number];

export function isStrictModuleManifest(
  manifest: ModuleManifest
): manifest is StrictModuleManifest {
  return manifest.format === MODULE_MANIFEST_FORMAT;
}

/**
 * What a Manifest asks of Module settings: a strict Manifest's `settings`
 * entries, plus its `resources` as minimums of the matching resource
 * settings. Legacy and absent Manifests ask nothing.
 */
export function moduleSettingRequests(
  manifest: ModuleManifest | null
): ModuleSettingRequests {
  if (manifest === null || !isStrictModuleManifest(manifest)) {
    return {};
  }
  // Validation admitted only setting keys (refineStrictManifest).
  const requests: Partial<Record<ModuleSettingKey, ModuleSettingRequest>> = {
    ...(manifest.settings as ModuleSettingRequests | undefined),
  };
  const { resources } = manifest;
  if (resources?.cpus !== undefined) {
    requests["resources.cpus"] = { minimum: resources.cpus };
  }
  if (resources?.memoryBytes !== undefined) {
    requests["resources.memoryBytes"] = { minimum: resources.memoryBytes };
  }
  return requests;
}

type RefinementContext = z.RefinementCtx;

function refineCapabilities(
  manifest: { readonly capabilities: readonly { readonly alias: string }[] },
  context: RefinementContext
): void {
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
}

/**
 * An Installation holds one Grant per Capability, so a second request for
 * one could never be granted beside the first. The legacy format's bytes
 * are frozen and keep their own rules.
 */
function refineOneRequestPerCapability(
  manifest: {
    readonly capabilities: readonly { readonly capability: string }[];
  },
  context: RefinementContext
): void {
  const capabilities = new Set<string>();
  for (const [index, request] of manifest.capabilities.entries()) {
    if (capabilities.has(request.capability)) {
      context.addIssue({
        code: "custom",
        message: `capability ${JSON.stringify(request.capability)} is requested more than once; request it once with the widest constraints`,
        path: ["capabilities", index, "capability"],
      });
    }
    capabilities.add(request.capability);
  }
}

function refineStrictManifest(
  manifest: z.output<typeof strictManifestSchema>,
  context: RefinementContext
): void {
  if (
    manifest.data !== undefined &&
    manifest.persistence?.files !== "installation"
  ) {
    context.addIssue({
      code: "custom",
      message: 'data requires persistence.files "installation"',
      path: ["persistence"],
    });
  }
  const hosts = new Set<string>();
  for (const [index, destination] of (
    manifest.network?.destinations ?? []
  ).entries()) {
    if (hosts.has(destination.host)) {
      context.addIssue({
        code: "custom",
        message: `network destination ${JSON.stringify(destination.host)} is duplicated`,
        path: ["network", "destinations", index, "host"],
      });
    }
    hosts.add(destination.host);
  }
  const views = new Set<string>();
  for (const [index, editor] of (manifest.editors ?? []).entries()) {
    if (!Object.hasOwn(manifest.views, editor.view)) {
      context.addIssue({
        code: "custom",
        message: `editor View ${JSON.stringify(editor.view)} is not declared in views`,
        path: ["editors", index, "view"],
      });
    }
    if (views.has(editor.view)) {
      context.addIssue({
        code: "custom",
        message: `editor View ${JSON.stringify(editor.view)} is declared more than once`,
        path: ["editors", index, "view"],
      });
    }
    views.add(editor.view);
    if (new Set(editor.mimeTypes).size !== editor.mimeTypes.length) {
      context.addIssue({
        code: "custom",
        message: "editor MIME types must be unique",
        path: ["editors", index, "mimeTypes"],
      });
    }
  }
  for (const [key, request] of Object.entries(manifest.settings ?? {})) {
    for (const problem of settingRequestProblems(key, request)) {
      context.addIssue({
        code: "custom",
        message: problem,
        path: ["settings", key],
      });
    }
  }
}

function settingRequestProblems(
  name: string,
  request: z.output<typeof settingRequestSchema>
): string[] {
  if (isResourceSettingKey(name)) {
    return [`declare ${name} in resources, not settings`];
  }
  const parsed = parseModuleSettingKey(name);
  if ("problem" in parsed) {
    return [parsed.problem];
  }
  const { key } = parsed;
  const problems: string[] = [];
  if (request.default === undefined && request.minimum === undefined) {
    problems.push(`${key} must declare a default or a minimum`);
  }
  for (const value of [request.default, request.minimum]) {
    const problem =
      value === undefined ? null : moduleSettingValueProblem(key, value);
    if (problem !== null) {
      problems.push(problem);
    }
  }
  if (
    request.default !== undefined &&
    request.minimum !== undefined &&
    request.default < request.minimum
  ) {
    problems.push(`${key} default must not be below its minimum`);
  }
  return problems;
}

export class ModuleManifestValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleManifestValidationError";
  }
}

export function parseModuleManifest(input: unknown): ModuleManifest {
  const format =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as { readonly format?: unknown }).format
      : undefined;
  if (!(MODULE_MANIFEST_FORMATS as readonly unknown[]).includes(format)) {
    throw new ModuleManifestValidationError(
      `invalid Module Manifest: unsupported format ${JSON.stringify(format ?? null)}; this reader supports ${MODULE_MANIFEST_FORMATS.join(" and ")}`
    );
  }
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
  const common = {
    capabilities,
    compatibility: { ...manifest.compatibility },
    program: { ...manifest.program },
    views,
    ...(manifest.data === undefined ? {} : { data: { ...manifest.data } }),
  };
  if (!isStrictModuleManifest(manifest)) {
    return deepFreeze({ ...common, format: manifest.format });
  }
  // Canonical JSON sorts keys, not arrays: order every array here so equal
  // declarations compare equal however their source was written.
  return deepFreeze({
    ...common,
    format: manifest.format,
    ...(manifest.editors === undefined
      ? {}
      : {
          editors: [...manifest.editors]
            .sort(byCodeUnit((editor) => editor.view))
            .map((editor) => ({
              ...editor,
              mimeTypes: [...editor.mimeTypes].sort(byCodeUnit(String)),
            })),
        }),
    ...(manifest.network === undefined
      ? {}
      : {
          network: {
            ...manifest.network,
            destinations: [...manifest.network.destinations]
              .sort(byCodeUnit((destination) => destination.host))
              .map((destination) =>
                destination.ports === undefined
                  ? { host: destination.host }
                  : {
                      host: destination.host,
                      ports: [...destination.ports].sort(
                        (left, right) => left - right
                      ),
                    }
              ),
          },
        }),
    ...(manifest.persistence === undefined
      ? {}
      : { persistence: { ...manifest.persistence } }),
    ...(manifest.resources === undefined
      ? {}
      : { resources: { ...manifest.resources } }),
    ...(manifest.settings === undefined
      ? {}
      : {
          settings: Object.fromEntries(
            Object.entries(manifest.settings)
              .sort(byCodeUnit(([key]) => key))
              .map(([key, request]) => [key, { ...request }])
          ),
        }),
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
