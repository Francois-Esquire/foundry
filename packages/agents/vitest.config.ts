import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/**/*.d.ts", "src/**/index.ts", "src/**/types.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
    },
    globals: true,
    include: ["src/test/**/*.test.ts"],
  },
});
