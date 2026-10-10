import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { build as bunBuild } from "bun";
import { build as buildTypes } from "tsup";
import { build } from "vite";
import { dependencies } from "../package.json" with { type: "json" };

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
/**
 * Every built entry and every shared chunk must stay in dist/lib, one
 * directory under dist: lib/worker-runtime.ts finds the workers beside
 * whichever file it was bundled into, and lib/serve.ts finds the viewer at
 * ../web. A deeper or shallower file breaks both.
 */
const outdir = resolve(dist, "lib");
const LIBRARY_ENTRY = "src/lib/index.ts";
/**
 * Each entry is named after its file (`[name].js`), so file names must be
 * unique across entries: that is why the CLI is `src/cli/atlas.ts`, not a
 * second `index.ts` beside the library's.
 */
const ENTRIES = [
  "src/cli/atlas.ts",
  LIBRARY_ENTRY,
  "src/lib/semantics-worker.ts",
  "src/lib/config-worker.ts",
];
/**
 * Only declared dependencies stay imports. Workspace `@foundry/*` packages
 * are declared in devDependencies, so they are inlined and the published
 * package never names a private one.
 */
const external = Object.keys(dependencies);
/** Workspace packages, whose declarations the dts pass inlines as well. */
const WORKSPACE_PACKAGES = /^@foundry\//;

/**
 * One build with shared chunks: the CLI and the library carry one copy of
 * the code they share, so the classes a consumer catches are the ones the
 * library throws.
 */
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
    throw new AggregateError(result.logs, "Atlas build failed.");
  }
}

/**
 * The library's declarations, bundled into one dist/lib/index.d.ts that
 * names only what the entry exports and what those names reach.
 */
async function declare(): Promise<void> {
  await buildTypes({
    config: false,
    dts: {
      compilerOptions: {
        // tsup still injects `baseUrl` for the dts pass; TypeScript 6 refuses it.
        ignoreDeprecations: "6.0",
        incremental: false,
        // From source, so the pass needs no build of @foundry/lib first. It
        // mirrors @foundry/lib's `./*` export, and @foundry/lib is the only
        // workspace package the library's types reach.
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

// The whole of dist, so nothing from an earlier layout is ever packed.
rmSync(dist, { force: true, recursive: true });
await bundle();
await declare();
await build({ configFile: resolve(root, "vite.config.ts") });
