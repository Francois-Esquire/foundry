import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/**/*.d.ts", "src/**/index.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
    },
    // Live reads of this machine's accounts run under `test:integration`.
    exclude: ["src/test/integration/**"],
    globals: true,
    include: ["src/test/**/*.test.ts"],
  },
});
