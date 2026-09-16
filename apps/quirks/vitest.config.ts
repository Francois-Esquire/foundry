import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@foundry/quirks": resolve(import.meta.dirname, "src/lib/index.ts"),
      "~": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    exclude: ["test/status-view.test.ts", "test/package.test.ts"],
    globals: true,
    include: ["test/**/*.test.ts"],
  },
});
