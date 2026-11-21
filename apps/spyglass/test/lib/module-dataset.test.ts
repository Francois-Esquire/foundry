import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BunPlugin, build as bundle } from "bun";
import { describe, expect, test } from "vitest";

const NATIVE_IMPORT = /^(node:|bun$)/;
const portableGuard: BunPlugin = {
  name: "portable-import-guard",
  setup(build) {
    build.onResolve({ filter: NATIVE_IMPORT }, ({ path }) => {
      throw new Error(`Native dependency in portable computation: ${path}`);
    });
  },
};
const MODULE_DATASET = /module-dataset\.ts$/;
const entrypoint = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../src/lib/module-dataset.ts"
);

describe("module dataset runtime boundary", () => {
  test("bundles computation for the browser without native adapters", async () => {
    const result = await bundle({
      entrypoints: [entrypoint],
      plugins: [portableGuard],
      target: "browser",
    });
    expect(result.success).toBe(true);
  });

  test("rejects a native dependency added to the computation graph", async () => {
    const result = await bundle({
      entrypoints: [entrypoint],
      plugins: [
        portableGuard,
        {
          name: "invalid-native-dependency",
          setup(build) {
            build.onLoad({ filter: MODULE_DATASET }, () => ({
              contents: `import { build as bundle, type BunPlugin } from "bun";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs"; console.log(readFileSync("input"));\n${readFileSync(entrypoint, "utf8")}`,
              loader: "ts",
            }));
          },
        },
      ],
      target: "browser",
      throw: false,
    });
    expect(result.success).toBe(false);
    expect(result.logs.map(String).join("\n")).toContain("node:fs");
  });
});
