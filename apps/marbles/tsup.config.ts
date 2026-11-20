import { cpSync, readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const INTERNAL = [
  "agents",
  "artifacts",
  "core",
  "lib",
  "models",
  "prompts",
  "sandbox",
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

const internalPaths = Object.fromEntries([
  ["~/*", ["./src/*"]],
  ["@foundry.sh/marbles", ["./src/authoring/index.ts"]],
  ...INTERNAL.flatMap(exportPaths),
]);

export default defineConfig({
  clean: true,
  dts: {
    compilerOptions: { ignoreDeprecations: "6.0", paths: internalPaths },
    resolve: true,
  },
  entry: {
    cli: "src/cli.ts",
    engine: "src/entries/engine.ts",
    generation: "src/process/generation.ts",
    index: "src/authoring/index.ts",
    lib: "src/entries/lib.ts",
    prebuilt: "src/authoring/prebuilt.ts",
    process: "src/process/index.ts",
    statuses: "src/lib/execution-statuses.ts",
    workspace: "src/workspace/index.ts",
  },
  esbuildOptions(options) {
    options.alias = { "@foundry.sh/marbles": "./src/authoring/index.ts" };
  },
  external: [/^(?!@foundry(?:\.sh)?\/)[^./~]/],
  format: ["esm"],
  noExternal: [/^@foundry(?:\.sh)?\//],
  onSuccess: async () => {
    cpSync("src/database/migrations", "dist/migrations", { recursive: true });
  },
  platform: "node",
  sourcemap: true,
  splitting: true,
  target: "esnext",
});
