import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { build as bunBuild } from "bun";
import { build as buildTypes } from "tsup";
import { build } from "vite";
import { dependencies } from "../package.json" with { type: "json" };

process.env.NODE_ENV = "production";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

const outdir = resolve(dist, "lib");
const LIBRARY_ENTRY = "src/lib/index.ts";

const ENTRIES = [
  "src/cli/spyglass.ts",
  LIBRARY_ENTRY,
  "src/lib/semantics-worker.ts",
  "src/lib/config-worker.ts",
];

const external = Object.keys(dependencies);
const WORKSPACE_PACKAGES = /^@foundry\//;

async function bundle(): Promise<void> {
  const result = await bunBuild({
    entrypoints: ENTRIES.map((entry) => resolve(root, entry)),
    external,
    naming: { chunk: "chunk-[hash].[ext]", entry: "[name].[ext]" },
    outdir,
    splitting: true,
    target: "bun",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Spyglass build failed.");
  }
}

async function declare(): Promise<void> {
  await buildTypes({
    config: false,
    dts: {
      compilerOptions: {
        ignoreDeprecations: "6.0",
        incremental: false,

        paths: { "@foundry/lib/*": ["../../packages/lib/src/*"] },
      },
      only: true,
      resolve: [WORKSPACE_PACKAGES],
    },
    entry: { index: resolve(root, LIBRARY_ENTRY) },
    format: "esm",
    outDir: outdir,
    silent: true,
    tsconfig: resolve(root, "tsconfig.json"),
  });
}

for (const packed of ["lib", "web"]) {
  rmSync(resolve(dist, packed), { force: true, recursive: true });
}
await bundle();
await declare();
await build({ configFile: resolve(root, "vite.config.ts") });
