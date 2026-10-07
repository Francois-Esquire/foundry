import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const INTERNAL = [
  "agents",
  "artifacts",
  "core",
  "lib",
  "models",
  "sandbox",
  "workflows",
  "workspaces",
];

type PackageExports = Record<string, string | { import?: string }>;

/**
 * One package's `exports`, as `paths` entries to its source. Read from the
 * manifest so a public subpath whose file differs from its name (`./git` is
 * `src/node/git.ts`) cannot drift from the map.
 */
function exportPaths(name: string): [string, string[]][] {
  const root = `../../packages/${name}`;
  const { exports } = JSON.parse(
    readFileSync(`${root}/package.json`, "utf8")
  ) as { exports: PackageExports };
  return Object.entries(exports).flatMap(([subpath, target]) => {
    const file = typeof target === "string" ? target : target.import;
    return file?.endsWith(".ts")
      ? [
          [
            `@foundry/${name}${subpath.slice(1)}`,
            [`${root}/${file.slice("./".length, -".ts".length)}`],
          ],
        ]
      : [];
  });
}

/**
 * The types pass resolves with a pre-`exports` resolver, so every internal
 * package's public entries are mapped straight to their source.
 */
const internalPaths = Object.fromEntries([
  ["~/*", ["./src/*"]],
  ["@foundry/marbles", ["./src/authoring/index.ts"]],
  ...INTERNAL.flatMap(exportPaths),
]);

/**
 * One build, shared chunks. A `marbles.config.ts` imports the authoring
 * words, the CLI imports the config, and a host imports the lib; all must
 * see the same catalog instance and run table, which only holds if those
 * live in one chunk that every entry loads.
 *
 * Every `@foundry/*` package is inlined so the built app carries no
 * `workspace:` or `catalog:` reference; only third-party bare imports stay
 * external and are declared in `dependencies`.
 */
export default defineConfig({
  clean: true,
  // tsup still injects `baseUrl` for the dts pass; TypeScript 6 refuses it.
  dts: {
    compilerOptions: { ignoreDeprecations: "6.0", paths: internalPaths },
    resolve: true,
  },
  entry: {
    cli: "src/cli.ts",
    index: "src/authoring/index.ts",
    lib: "src/lib/index.ts",
    prebuilt: "src/authoring/prebuilt.ts",
  },
  esbuildOptions(options) {
    options.alias = { "@foundry/marbles": "./src/authoring/index.ts" };
  },
  external: [/^(?!@foundry\/)[^./~]/],
  format: ["esm"],
  noExternal: [/^@foundry\//],
  platform: "node",
  sourcemap: true,
  splitting: true,
  target: "esnext",
});
