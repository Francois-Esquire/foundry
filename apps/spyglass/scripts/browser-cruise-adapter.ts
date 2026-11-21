import { existsSync } from "node:fs";
import { builtinModules, createRequire, isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFsFromVolume, Volume } from "memfs";
import type { Plugin, PluginOption } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const require = createRequire(import.meta.url);
const cruiserSource = join(
  dirname(require.resolve("dependency-cruiser/package.json")),
  "src"
);

const PREFIX = "\0spyglass-cruise:";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const SHIMS: Record<string, string> = {
  "cache-only": `const unavailable = (name) => () => { throw new Error(name + " is unavailable in a browser cruise"); };
export const createHash = unavailable("crypto.createHash");
export const brotliCompressSync = unavailable("zlib.brotliCompressSync");
export const brotliDecompressSync = unavailable("zlib.brotliDecompressSync");
export const constants = {};
export default {};`,

  "child-process": `export function spawn() { throw new Error("child_process is unavailable in a browser cruise"); }
export default { spawn };`,

  console: `export class Console {
  constructor() {
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      this[method] = (...args) => globalThis.console[method](...args);
    }
  }
}
export default { Console };`,
  // Keep this volume private so repository imports cannot read host files.

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

  inspector: `export class Session { constructor() { throw new Error("inspector is unavailable in a browser cruise"); } }
export default { Session };`,

  "legacy-inner-callback": `export default function createInnerCallback() { throw new Error("legacy enhanced-resolve path is unreachable"); }`,

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

  path: `import posix from "path-browserify";
const unreachable = (name) => () => { throw new Error("path.win32." + name + " is unavailable in a browser cruise"); };
const win32 = Object.fromEntries(["normalize", "join", "resolve", "relative", "dirname", "basename", "extname", "isAbsolute", "parse", "format", "toNamespacedPath"].map((name) => [name, unreachable(name)]));
win32.sep = "\\\\";
win32.delimiter = ";";
const path = { ...posix, posix, win32 };
export default path;
export const { basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, relative, resolve, sep, toNamespacedPath } = path;
export { posix, win32 };`,

  "perf-hooks": `export const performance = globalThis.performance;
export const PerformanceObserver = globalThis.PerformanceObserver;
export default { performance, PerformanceObserver };`,

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
