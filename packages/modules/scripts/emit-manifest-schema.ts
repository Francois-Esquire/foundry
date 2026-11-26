import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODULE_MANIFEST_SCHEMA_PATH,
  moduleManifestJsonSchema,
} from "../src/manifest-schema";

await writeFile(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    MODULE_MANIFEST_SCHEMA_PATH
  ),
  `${JSON.stringify(moduleManifestJsonSchema(), null, 2)}\n`,
  "utf8"
);
