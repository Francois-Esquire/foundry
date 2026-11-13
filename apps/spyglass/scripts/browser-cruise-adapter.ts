import { existsSync } from "node:fs";
import { builtinModules, createRequire, isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFsFromVolume, Volume } from "memfs";
import type { Plugin, PluginOption } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Vite plugins that let a bundle run dependency-cruiser unchanged over a
// private in-memory volume: the isolated file-map cruise engine
// (`src/lib/file-map-cruise-engine.ts`, built to `dist/engine` by
// `scripts/build.ts` for Bun), and the browser analysis asset that bundles
// the same engine with everything else a page scan needs
// (`src/lib/browser-analysis.ts`, built to `dist/scan/analysis`). The cruiser reads
// input through synchronous `node:fs` and hands enhanced-resolve a
// CachedInputFileSystem over that same `fs`, so its public options cannot
// redirect it; the bundle instead resolves `node:fs` to a memfs volume of its
// own, created inside the bundle, so no host path (absolute, escaping, a
// package or an `extends`) can be read. The fs module also exports
// `isolatedVolume` (also on its default export), which the engine requires
// before it writes anything.
// Generic Node modules (stream, util, events, buffer, os, ...) come from the
// maintained node-stdlib-browser set through vite-plugin-node-polyfills,
// imported where used rather than installed as globals. Three cruiser
// modules that load code by a computed name are replaced: TypeScript is the
// only transpiler, the cruise result object the only report, and no external
// plugin or reporter can load. No cruiser source is patched, and no
// configuration, plugin or script of an analyzed repository runs.
//
// These plugins belong only to those two builds. The viewer and the scan
// page never use this adapter, so their Node-builtin guard stays whole; the
// asset's build runs the same guard after these plugins, so a built-in they
// do not answer fails it.

const require = createRequire(import.meta.url);
const cruiserSource = join(
  dirname(require.resolve("dependency-cruiser/package.json")),
  "src"
);

const PREFIX = "\0spyglass-cruise:";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Shim modules by id: each one is the whole module source. */
const SHIMS: Record<string, string> = {
  // Cache-only modules: a browser cruise runs without a cache.
  "cache-only": `const unavailable = (name) => () => { throw new Error(name + " is unavailable in a browser cruise"); };
export const createHash = unavailable("crypto.createHash");
export const brotliCompressSync = unavailable("zlib.brotliCompressSync");
export const brotliDecompressSync = unavailable("zlib.brotliDecompressSync");
export const constants = {};
export default {};`,
  // A child process is only spawned for Git-based `since` filtering.
  "child-process": `export function spawn() { throw new Error("child_process is unavailable in a browser cruise"); }
export default { spawn };`,
  // tsconfig-paths-webpack-plugin's logger constructs Consoles over streams.
  console: `export class Console {
  constructor() {
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      this[method] = (...args) => globalThis.console[method](...args);
    }
  }
}
export default { Console };`,
  // The whole fs surface over a volume private to the bundle, as named and
  // default exports, plus the handle the engine resets it through.
  fs: `import { createFsFromVolume, Volume } from "memfs";
const volume = new Volume();
const fs = createFsFromVolume(volume);
export const isolatedVolume = { reset: () => volume.reset() };
fs.isolatedVolume = isolatedVolume;
export default fs;
export const promises = fs.promises;
export const { ${Object.keys(createFsFromVolume(new Volume()))
    .filter((key) => IDENTIFIER.test(key) && key !== "promises")
    .join(", ")} } = fs;`,
  "fs-promises": `import fs from "node:fs";
export default fs.promises;
export const { readFile, writeFile, readdir, stat, mkdir, rm } = fs.promises;`,
  // TypeScript's Node system profiles through the inspector; no browser
  // system is ever built that way.
  inspector: `export class Session { constructor() { throw new Error("inspector is unavailable in a browser cruise"); } }
export default { Session };`,
  // A legacy (webpack < 4) branch of tsconfig-paths-webpack-plugin.
  "legacy-inner-callback": `export default function createInnerCallback() { throw new Error("legacy enhanced-resolve path is unreachable"); }`,
  // Core-module classification answers as the build runtime does.
  module: `const BUILTIN = new Set(${JSON.stringify(
    [
      ...new Set(
        builtinModules.flatMap((name) => [
          name,
          name.startsWith("node:") ? name.slice(5) : `node:${name}`,
        ])
      ),
    ]
      .filter((name) => isBuiltin(name))
      .sort()
  )});
export const builtinModules = ${JSON.stringify(builtinModules)};
export function isBuiltin(name) { return BUILTIN.has(name); }
export function createRequire() { throw new Error("createRequire is unavailable in a browser cruise"); }
export default { builtinModules, isBuiltin, createRequire };`,
  // path-browserify is POSIX only; enhanced-resolve reads path.win32 at load.
  path: `import posix from "path-browserify";
const unreachable = (name) => () => { throw new Error("path.win32." + name + " is unavailable in a browser cruise"); };
const win32 = Object.fromEntries(["normalize", "join", "resolve", "relative", "dirname", "basename", "extname", "isAbsolute", "parse", "format", "toNamespacedPath"].map((name) => [name, unreachable(name)]));
win32.sep = "\\\\";
win32.delimiter = ";";
const path = { ...posix, posix, win32 };
export default path;
export const { basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, relative, resolve, sep, toNamespacedPath } = path;
export { posix, win32 };`,
  // TypeScript's optional native performance hooks are the browser's own.
  "perf-hooks": `export const performance = globalThis.performance;
export const PerformanceObserver = globalThis.PerformanceObserver;
export default { performance, PerformanceObserver };`,
  // The polyfill's process, with the named exports the cruiser imports; its
  // platform is not "win32", so path handling stays POSIX.
  process: `import process from "vite-plugin-node-polyfills/shims/process";
export default process;
export const { cwd, env, platform, versions } = process;`,
  "report-index": `import identity from ${JSON.stringify(join(cruiserSource, "report/identity.mjs"))};
export async function getReporter(outputType) {
  if (outputType !== undefined && outputType !== "json-object") {
    throw new Error("reporter " + outputType + " is unavailable in a browser cruise");
  }
  return identity;
}
export function getAvailableReporters() { return []; }`,
  "try-import": `import typescript from "typescript";
export default async function tryImport(name) { return name === "typescript" ? typescript : false; }`,
  "try-import-available": `export default function tryImportAvailable(name) { return name === "typescript"; }`,
};

/** Builtin and package specifiers answered by a shim. */
const SPECIFIERS: Record<string, string> = {
  child_process: "child-process",
  console: "console",
  crypto: "cache-only",
  "enhanced-resolve/lib/createInnerCallback": "legacy-inner-callback",
  fs: "fs",
  "fs/promises": "fs-promises",
  "graceful-fs": "fs",
  inspector: "inspector",
  module: "module",
  path: "path",
  "path/posix": "path",
  perf_hooks: "perf-hooks",
  process: "process",
  zlib: "cache-only",
};

/** Cruiser modules, by path below its `src`, replaced by a shim. */
const CRUISER_MODULES: Record<string, string> = {
  "extract/transpile/try-import-available.mjs": "try-import-available",
  "report/index.mjs": "report-index",
  "utl/try-import.mjs": "try-import",
};

for (const leaf of Object.keys(CRUISER_MODULES)) {
  if (!existsSync(join(cruiserSource, leaf))) {
    throw new Error(
      `dependency-cruiser no longer has src/${leaf}; the browser cruise adapter must be updated.`
    );
  }
}

function cruiserShims(): Plugin {
  return {
    enforce: "pre",
    load(id) {
      return id.startsWith(PREFIX) ? SHIMS[id.slice(PREFIX.length)] : null;
    },
    name: "spyglass:browser-cruise-shims",
    async resolveId(source, importer, options) {
      const bare = source.startsWith("node:") ? source.slice(5) : source;
      const shim = SPECIFIERS[bare];
      if (shim !== undefined) {
        return `${PREFIX}${shim}`;
      }
      // A shim's own imports (memfs, path-browserify, ...) resolve from this
      // package, whatever root the build has.
      const resolved = await this.resolve(
        source,
        importer?.startsWith(PREFIX)
          ? fileURLToPath(import.meta.url)
          : importer,
        { ...options, skipSelf: true }
      );
      for (const [leaf, replacement] of Object.entries(CRUISER_MODULES)) {
        if (resolved?.id === join(cruiserSource, leaf)) {
          return `${PREFIX}${replacement}`;
        }
      }
      return resolved;
    },
  };
}

/**
 * The plugins the engine build adds to bundle dependency-cruiser: the shims
 * above, then node-stdlib-browser polyfills for the remaining Node modules
 * and the `process`, `Buffer` and `global` references they assume, injected
 * as imports so the host's own globals are never replaced.
 */
export function browserCruiseAdapter(): PluginOption[] {
  return [
    cruiserShims(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      include: [
        "assert",
        "buffer",
        "events",
        "os",
        "stream",
        "string_decoder",
        "timers",
        "url",
        "util",
      ],
    }),
  ];
}
