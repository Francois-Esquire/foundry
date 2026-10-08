import { sha256Hex } from "@foundry/lib/digest";
import { canonicalizeJson } from "@foundry/lib/json";

import { MODULE_SDK_EMITTED } from "./emitted";
import { MODULE_SDK_GENERATOR_ENTRYPOINT } from "./generator-source";
import { MODULE_SDK_ENTRYPOINT } from "./source";

export const MODULE_SDK_PACKAGE_NAME = "@foundry/module-sdk";
export const MODULE_SDK_VERSION = "0.1.0";

export interface ModuleSdkPack {
  readonly digest: string;
  readonly files: Readonly<Record<string, string>>;
  readonly packageName: string;
  readonly version: string;
}

function sdkFiles(): Readonly<Record<string, string>> {
  return Object.freeze({
    "dist/generate.d.ts": MODULE_SDK_EMITTED.generatorDeclarations,
    "dist/generate.js": MODULE_SDK_EMITTED.generatorEsm,
    "dist/index.d.ts": MODULE_SDK_EMITTED.declarations,
    "dist/index.js": MODULE_SDK_EMITTED.esm,
    "package.json": `${JSON.stringify(
      {
        exports: {
          // biome-ignore assist/source/useSortedKeys: TypeScript matches export conditions in order, so `types` comes first
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          // biome-ignore assist/source/useSortedKeys: TypeScript matches export conditions in order, so `types` comes first
          "./generate": {
            types: "./dist/generate.d.ts",
            import: "./dist/generate.js",
          },
        },
        name: MODULE_SDK_PACKAGE_NAME,
        private: true,
        scripts: {
          format: "prettier --check . --ignore-path ../../.prettierignore",
          "format:fix":
            "prettier --write . --ignore-path ../../.prettierignore",
          generate: "bun scripts/generate.ts",
          lint: "eslint src scripts",
          "lint:fix": "eslint src scripts --fix",
          typecheck: "tsc --noEmit -p tsconfig.json",
        },
        type: "module",
        version: MODULE_SDK_VERSION,
      },
      null,
      2
    )}\n`,
    "scripts/generate.ts": `import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeModuleGatewayClient } from "../src/generate";

const root = path.resolve("../..");
const catalogPath = process.env.FOUNDRY_MODULE_CATALOG_PATH;
const catalog =
  catalogPath === undefined
    ? { generation: 0, capabilities: [] }
    : JSON.parse(await readFile(catalogPath, "utf8"));

await writeModuleGatewayClient({ root, catalog });
`,
    "src/generate.ts": MODULE_SDK_GENERATOR_ENTRYPOINT,
    "src/index.ts": MODULE_SDK_ENTRYPOINT,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: { types: ["bun"] },
        extends: "../../tsconfig.json",
        include: ["src", "scripts", "generated"],
      },
      null,
      2
    )}\n`,
  });
}

export async function buildModuleSdkPack(): Promise<ModuleSdkPack> {
  const files = sdkFiles();
  const digest = await sha256Hex(canonicalizeJson(files));
  return Object.freeze({
    digest,
    files,
    packageName: MODULE_SDK_PACKAGE_NAME,
    version: MODULE_SDK_VERSION,
  });
}

export async function assertModuleSdkPack(pack: ModuleSdkPack): Promise<void> {
  if (pack.packageName !== MODULE_SDK_PACKAGE_NAME) {
    throw new Error(`SDK package must be named ${MODULE_SDK_PACKAGE_NAME}`);
  }
  const digest = await sha256Hex(canonicalizeJson(pack.files));
  if (digest !== pack.digest) {
    throw new Error("Module SDK pack digest does not match its files");
  }
}
