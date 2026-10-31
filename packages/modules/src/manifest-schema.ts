/**
 * The Module Manifest JSON Schema: editor assistance for `foundry.module.json`.
 *
 * It is generated from the authoritative parser's Zod schema, so it accepts
 * the shapes the parser accepts but not the refinements JSON Schema cannot
 * state (path, uniqueness, View existence, setting keys). Schema acceptance
 * is never validation; `parseModuleManifest` is.
 *
 * Run `bun run emit-manifest-schema` after changing the Manifest schema;
 * `manifest-schema-emit.ts` writes `schema/foundry.module.schema.json` and
 * Biome formats it.
 * `module-manifest-schema.test.ts` fails when the committed file is stale.
 */
import { z } from "zod";

import { MODULE_MANIFEST_SOURCE_PATH, moduleManifestSchema } from "./manifest";

/** Where the generated schema is committed, relative to the package root. */
export const MODULE_MANIFEST_SCHEMA_PATH = "schema/foundry.module.schema.json";

/** The configuration filename editors map the schema to. */
export const MODULE_MANIFEST_SCHEMA_FILE_MATCH = Object.freeze([
  MODULE_MANIFEST_SOURCE_PATH,
]);

export function moduleManifestJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(moduleManifestSchema, {
      io: "input",
      unrepresentable: "any",
    }),
    description:
      "Editor assistance for foundry.module.json. Foundry's Manifest parser is authoritative: it also checks paths, uniqueness, View references and setting keys.",
    title: "Foundry Module Manifest",
  };
}
