import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@foundry/quirks": resolve(import.meta.dirname, "src/authoring/index.ts"),
      "@foundry/quirks/lib": resolve(import.meta.dirname, "src/lib/index.ts"),
      "@foundry/quirks/prebuilt": resolve(
        import.meta.dirname,
        "src/authoring/prebuilt.ts"
      ),
      "~": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    exclude: [
      "test/**/*.integration.test.ts",
      "test/status-view.test.ts",
      "test/package.test.ts",
      "test/cli-terminal.test.ts",
      "test/identity.test.ts",
    ],
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
