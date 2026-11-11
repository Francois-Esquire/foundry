import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const source = (path: string) => resolve(import.meta.dirname, "src", path);

export default defineConfig({
  resolve: {
    // Exact matches: a prefix alias for the main entry would also capture
    // `@foundry.sh/marbles/lib` and the other subpaths.
    alias: [
      {
        find: /^@foundry\.sh\/marbles$/,
        replacement: source("authoring/index.ts"),
      },
      {
        find: /^@foundry\.sh\/marbles\/lib$/,
        replacement: source("lib/index.ts"),
      },
      {
        find: /^@foundry\.sh\/marbles\/prebuilt$/,
        replacement: source("authoring/prebuilt.ts"),
      },
      {
        find: /^@foundry\.sh\/marbles\/process$/,
        replacement: source("process/index.ts"),
      },
      {
        find: /^@foundry\.sh\/marbles\/workspace$/,
        replacement: source("workspace/index.ts"),
      },
      { find: /^~\//, replacement: `${source("")}/` },
    ],
  },
  test: {
    // The integration and package suites have configurations of their own.
    exclude: ["test/**/*.integration.test.ts", "test/package.test.ts"],
    // Bun installs a package it cannot resolve unless told not to, which
    // would hand the identity tests a `typescript` their project lacks.
    execArgv: ["--no-install"],
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    // Vitest runs on Bun, which OpenTUI's renderer needs; Bun drops zod's
    // `z` export when Vitest imports it as an external module.
    server: { deps: { inline: ["zod"] } },
  },
});
