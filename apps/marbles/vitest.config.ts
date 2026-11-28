import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      ["@foundry.sh/marbles", "src/authoring/index.ts"],
      ["@foundry.sh/marbles/engine", "src/entries/engine.ts"],
      ["@foundry.sh/marbles/lib", "src/entries/lib.ts"],
      ["@foundry.sh/marbles/prebuilt", "src/authoring/prebuilt.ts"],
      ["@foundry.sh/marbles/process", "src/process/index.ts"],
      ["@foundry.sh/marbles/providers", "src/authoring/providers.ts"],
      ...["claude-code", "codex", "gateway", "pi", "vercel"].map(
        (name) =>
          [
            `@foundry.sh/marbles/providers/${name}`,
            `src/lib/providers/${name}.ts`,
          ] as const
      ),
      ["@foundry.sh/marbles/statuses", "src/lib/execution-statuses.ts"],
      ["@foundry.sh/marbles/workspace", "src/workspace/index.ts"],
    ]
      .map(([name, file]) => ({
        find: new RegExp(`^${name.replaceAll(".", "\\.")}$`),
        replacement: resolve(import.meta.dirname, file),
      }))
      .concat({
        find: /^~\//,
        replacement: `${resolve(import.meta.dirname, "src")}/`,
      }),
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
