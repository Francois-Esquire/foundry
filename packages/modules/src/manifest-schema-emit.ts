/**
 * Writes the generated Manifest JSON Schema to the committed file.
 *
 * Only the `emit-manifest-schema` script runs this file; no runtime module
 * imports it, so the package's runtime keeps no filesystem access outside
 * its Node entry. The script formats the output with Biome next.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODULE_MANIFEST_SCHEMA_PATH,
  moduleManifestJsonSchema,
} from "./manifest-schema";

await writeFile(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    MODULE_MANIFEST_SCHEMA_PATH
  ),
  `${JSON.stringify(moduleManifestJsonSchema(), null, 2)}\n`,
  "utf8"
);
