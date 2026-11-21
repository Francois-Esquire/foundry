import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@foundry\.sh\/marbles$/,
        replacement: resolve(import.meta.dirname, "src/authoring/index.ts"),
      },
      {
        find: "@foundry.sh/marbles/engine",
        replacement: resolve(import.meta.dirname, "src/entries/engine.ts"),
      },
      {
        find: "@foundry.sh/marbles/lib",
        replacement: resolve(import.meta.dirname, "src/entries/lib.ts"),
      },
      {
        find: "@foundry.sh/marbles/prebuilt",
        replacement: resolve(import.meta.dirname, "src/authoring/prebuilt.ts"),
      },
      {
        find: "@foundry.sh/marbles/process",
        replacement: resolve(import.meta.dirname, "src/process/index.ts"),
      },
      {
        find: "@foundry.sh/marbles/statuses",
        replacement: resolve(
          import.meta.dirname,
          "src/lib/execution-statuses.ts"
        ),
      },
      {
        find: "@foundry.sh/marbles/workspace",
        replacement: resolve(import.meta.dirname, "src/workspace/index.ts"),
      },
      { find: "~", replacement: resolve(import.meta.dirname, "src") },
    ],
  },
  test: {
    exclude: ["test/**/*.integration.test.ts", "test/package.test.ts"],
    execArgv: ["--no-install"],
    globalSetup: ["test/helpers/migrations.ts", "test/helpers/setup.ts"],
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    server: { deps: { inline: ["zod"] } },
    setupFiles: ["test/helpers/guard.ts"],
  },
});
