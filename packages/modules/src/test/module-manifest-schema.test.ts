import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseModuleManifest } from "../manifest";
import {
  MODULE_MANIFEST_SCHEMA_FILE_MATCH,
  MODULE_MANIFEST_SCHEMA_PATH,
  moduleManifestJsonSchema,
} from "../manifest-schema";
import { STRICT_MANIFEST } from "./helpers/module-fixture";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

interface Schema {
  readonly oneOf: readonly {
    readonly properties: Record<string, unknown>;
    readonly additionalProperties: boolean;
  }[];
}

describe("Module Manifest JSON Schema", () => {
  it("is committed in sync with the parser (run `bun run emit-manifest-schema`)", async () => {
    const committed = JSON.parse(
      await readFile(
        path.join(packageRoot, MODULE_MANIFEST_SCHEMA_PATH),
        "utf8"
      )
    ) as unknown;
    expect(committed).toEqual(moduleManifestJsonSchema());
  });

  it("maps to the configuration filename, also in the repository's editor settings", async () => {
    expect(MODULE_MANIFEST_SCHEMA_FILE_MATCH).toEqual(["foundry.module.json"]);
    const settings = JSON.parse(
      await readFile(
        path.join(packageRoot, "../../.vscode/settings.json"),
        "utf8"
      )
    ) as { "json.schemas": { fileMatch: string[]; url: string }[] };
    expect(settings["json.schemas"]).toContainEqual({
      fileMatch: ["foundry.module.json"],
      url: `./packages/modules/${MODULE_MANIFEST_SCHEMA_PATH}`,
    });
  });

  it("describes both formats without a $schema property in either", () => {
    const schema = moduleManifestJsonSchema() as unknown as Schema;
    expect(
      schema.oneOf.map(
        (member) => (member.properties.format as { const: string }).const
      )
    ).toEqual(["foundry.module/1", "foundry.module-manifest/1"]);
    for (const member of schema.oneOf) {
      expect(member.additionalProperties).toBe(false);
      expect(member.properties).not.toHaveProperty("$schema");
    }
  });

  it("is assistance, not validation: refinements stay with the parser", () => {
    // Schema-shaped (an editor names a View the schema cannot check), yet invalid.
    const shaped = {
      ...STRICT_MANIFEST,
      editors: [{ mimeTypes: ["text/plain"], mode: "read", view: "missing" }],
    };
    expect(() => parseModuleManifest(shaped)).toThrow("not declared in views");
  });
});
