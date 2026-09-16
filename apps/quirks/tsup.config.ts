import { defineConfig } from "tsup";

const INTERNAL = ["agents", "lib", "models", "workflows", "workspaces"];

/**
 * The types pass resolves with a pre-`exports` resolver, so every internal
 * package is mapped straight to its source; entries whose public file differs
 * from its name are spelled out.
 */
const internalPaths = Object.fromEntries([
  ["~/*", ["./src/*"]],
  ["@foundry/quirks", ["./src/lib/index.ts"]],
  ...INTERNAL.flatMap((name) => [
    [`@foundry/${name}`, [`../../packages/${name}/src/index`]],
    [
      `@foundry/${name}/*`,
      [`../../packages/${name}/src/*`, `../../packages/${name}/src/*/index`],
    ],
  ]),
  ["@foundry/lib/config", ["../../packages/lib/src/config/config"]],
  [
    "@foundry/workflows/channels",
    ["../../packages/workflows/src/channels-public"],
  ],
  [
    "@foundry/workflows/executable",
    ["../../packages/workflows/src/executable-public"],
  ],
  [
    "@foundry/workflows/snapshot",
    ["../../packages/workflows/src/snapshot-public"],
  ],
]);

/**
 * One build, two entries, shared chunks. A `quirks.config.ts` imports the lib
 * and the CLI imports the config; both must see the same registry instance,
 * which only holds if the registry lives in one chunk that both entries load.
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
  entry: { cli: "src/cli.ts", index: "src/lib/index.ts" },
  esbuildOptions(options) {
    options.alias = { "@foundry/quirks": "./src/lib/index.ts" };
  },
  external: [/^(?!@foundry\/)[^./~]/],
  format: ["esm"],
  noExternal: [/^@foundry\//],
  platform: "node",
  sourcemap: true,
  splitting: true,
  target: "esnext",
});
