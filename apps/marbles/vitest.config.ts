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
    exclude: ["test/**/*.integration.test.ts", "test/package.test.ts"],
    execArgv: ["--no-install"],
    globalSetup: ["test/helpers/migrations.ts", "test/helpers/setup.ts"],
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    server: { deps: { inline: ["zod"] } },
    setupFiles: ["test/helpers/guard.ts"],
  },
});
