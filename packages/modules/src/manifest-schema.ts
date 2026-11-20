import { z } from "zod";

import { MODULE_MANIFEST_SOURCE_PATH, moduleManifestSchema } from "./manifest";

export const MODULE_MANIFEST_SCHEMA_PATH = "schema/foundry.module.schema.json";

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
