import { cpSync, readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const INTERNAL = [
  "agents",
  "artifacts",
  "authorization",
  "core",
  "lib",
  "models",
  "prompts",
  "queue",
  "sandbox",
  "scheduling",
  "tasks",
  "usage",
  "workflows",
  "workspaces",
];

type PackageExports = Record<string, string | { import?: string }>;

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

const PROVIDERS = ["claude-code", "codex", "gateway", "pi", "vercel"];

const providerEntries = Object.fromEntries(
  PROVIDERS.map((name) => [`providers/${name}`, `src/providers/${name}.ts`])
);

const selfImports: Record<string, string> = {
  "@foundry.sh/marbles": "./src/authoring/index.ts",
  "@foundry.sh/marbles/providers": "./src/authoring/providers.ts",
  ...Object.fromEntries(
    PROVIDERS.map((name) => [
      `@foundry.sh/marbles/providers/${name}`,
      `./src/providers/${name}.ts`,
    ])
  ),
};

const internalPaths = Object.fromEntries([
  ["~/*", ["./src/*"]],
  ...Object.entries(selfImports).map(([name, file]) => [name, [file]]),
  ...INTERNAL.flatMap(exportPaths),
]);

const SHARED = {
  external: [/^(?!@foundry(?:\.sh)?\/)[^./~]/],
  format: ["esm"] as ["esm"],
  noExternal: [/^@foundry(?:\.sh)?\//],
  sourcemap: true,
  splitting: true,
  target: "esnext" as const,
};

export default defineConfig([
  {
    ...SHARED,
    clean: false,
    dts: false,
    entry: {
      index: "src/authoring/index.ts",
      lib: "src/lib/index.ts",
      providers: "src/authoring/providers.ts",
      statuses: "src/lib/executions/statuses.ts",
    },
    esbuildOptions(options) {
      options.alias = selfImports;
      options.chunkNames = "portable-[hash]";
    },
    platform: "neutral",
  },
  {
    ...SHARED,
    clean: false,
    dts: false,
    entry: {
      cli: "src/cli.ts",
      daemon: "src/process/daemon-entry.ts",
      engine: "src/entries/embedded.ts",
      generation: "src/process/generation.ts",
      process: "src/process/index.ts",
      ...providerEntries,
      workspace: "src/workspace/index.ts",
    },
    esbuildOptions(options) {
      options.alias = selfImports;
      options.chunkNames = "node-[hash]";
    },
    onSuccess: async () => {
      cpSync("src/database/migrations", "dist/migrations", {
        filter: (src) => !src.endsWith("bundled.ts"),
        recursive: true,
      });
    },
    platform: "node",
  },
  {
    ...SHARED,
    clean: false,
    dts: {
      banner: '/// <reference types="node" />',
      compilerOptions: { ignoreDeprecations: "6.0", paths: internalPaths },
      only: true,
      resolve: true,
    },
    entry: {
      cli: "src/cli.ts",
      daemon: "src/process/daemon-entry.ts",
      engine: "src/entries/embedded.ts",
      generation: "src/process/generation.ts",
      index: "src/authoring/index.ts",
      lib: "src/lib/index.ts",
      process: "src/process/index.ts",
      providers: "src/authoring/providers.ts",
      ...providerEntries,
      statuses: "src/lib/executions/statuses.ts",
      workspace: "src/workspace/index.ts",
    },
  },
]);
