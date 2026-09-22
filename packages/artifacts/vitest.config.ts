import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/test/**", "**/*.d.ts", "dist/**", "**/index.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    globals: true,
    include: ["src/test/**/*.test.ts"],
  },
});
