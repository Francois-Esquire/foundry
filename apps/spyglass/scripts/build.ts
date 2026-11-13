import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { build as bunBuild } from "bun";
import { build as buildTypes } from "tsup";
import { build, defaultClientConditions } from "vite";
import { dependencies } from "../package.json" with { type: "json" };
import { browserCruiseAdapter } from "./browser-cruise-adapter";
import { noNodeBuiltins } from "./no-node-builtins";

// Published viewer assets are always production, even when the caller is in development.
process.env.NODE_ENV = "production";

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
 * unique across entries: that is why the CLI is `src/cli/spyglass.ts`, not a
 * second `index.ts` beside the library's.
 */
const ENTRIES = [
  "src/cli/spyglass.ts",
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
const WORKSPACE_PACKAGES = /^@foundry\//;

/**
 * The isolated file-map cruise engine (`src/lib/file-map-cruise-engine.ts`)
 * at dist/engine, which `#file-map-cruise-engine` names. The adapter bundles
 * dependency-cruiser over a private in-memory `node:fs`; `typescript`, the
 * cruiser's own compiler, stays an import. It is built first, so any bundle
 * below that reaches it inlines it; tests and browser builds import it. It
 * is a build intermediate, not packed (package.json `files`).
 */
async function engine(): Promise<void> {
  await build({
    build: {
      emptyOutDir: true,
      lib: {
        entry: resolve(root, "src/lib/file-map-cruise-engine.ts"),
        fileName: "file-map-cruise-engine",
        formats: ["es"],
      },
      minify: false,
      outDir: resolve(dist, "engine"),
      // One file, so the engine is a single module wherever it is loaded.
      rolldownOptions: {
        external: ["typescript"],
        output: { codeSplitting: false },
      },
      target: "esnext",
    },
    configFile: false,
    logLevel: "warn",
    plugins: browserCruiseAdapter(),
    publicDir: false,
    resolve: { conditions: ["spyglass-browser", ...defaultClientConditions] },
    root,
  });
}

/** Where the scan page loads the browser analysis asset from: `analysis/` beside it. */
const SCAN = resolve(dist, "scan");

/**
 * The browser analysis asset (`src/lib/browser-analysis.ts`): one
 * self-contained ES module holding the GitHub loader, TypeScript, ts-morph
 * and dependency-cruiser, built with the cruise adapter and the
 * `spyglass-browser` condition, so the engine's `node:fs` is the private
 * volume and nothing stays an import. The Node-builtin guard runs after
 * the adapter, so any built-in the adapter does not answer fails the build.
 * The scan page loads it by URL; it is not packed (package.json `files`).
 */
export async function analysisAsset(outDir: string): Promise<void> {
  await build({
    build: {
      emptyOutDir: true,
      lib: {
        entry: resolve(root, "src/lib/browser-analysis.ts"),
        fileName: "spyglass-analysis",
        formats: ["es"],
      },
      outDir,
      reportCompressedSize: false,
      rolldownOptions: { output: { codeSplitting: false } },
      target: "es2022",
    },
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "warn",
    plugins: [...browserCruiseAdapter(), noNodeBuiltins()],
    publicDir: false,
    resolve: { conditions: ["spyglass-browser", ...defaultClientConditions] },
    root,
  });
}

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
    throw new AggregateError(result.logs, "Spyglass build failed.");
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

if (import.meta.main) {
  // The whole of dist, so nothing from an earlier layout is ever packed.
  rmSync(dist, { force: true, recursive: true });
  await engine();
  await bundle();
  await declare();
  await build({ configFile: resolve(root, "vite.config.ts") });
  // The scan page, then its asset beside it (the page's build empties dist/scan).
  await build({ configFile: resolve(root, "vite.scan.config.ts") });
  await analysisAsset(resolve(SCAN, "analysis"));
}
