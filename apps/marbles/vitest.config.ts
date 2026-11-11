import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@foundry.sh/marbles": resolve(
        import.meta.dirname,
        "src/authoring/index.ts"
      ),
      "@foundry.sh/marbles/lib": resolve(
        import.meta.dirname,
        "src/lib/index.ts"
      ),
      "@foundry.sh/marbles/prebuilt": resolve(
        import.meta.dirname,
        "src/authoring/prebuilt.ts"
      ),
      "~": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    // The integration and package suites have configurations of their own.
    exclude: ["test/**/*.integration.test.ts", "test/package.test.ts"],
    // Bun installs a package it cannot resolve unless told not to, which
    // would hand the identity tests a `typescript` their project lacks.
    execArgv: ["--no-install"],
    globalSetup: ["test/helpers/setup.ts"],
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    // Vitest runs on Bun, which OpenTUI's renderer needs; Bun drops zod's
    // `z` export when Vitest imports it as an external module.
    server: { deps: { inline: ["zod"] } },
  },
});
