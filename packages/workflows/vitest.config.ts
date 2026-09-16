import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "src/test/**",
        "**/*.test.ts",
        "**/*.d.ts",
        "dist/**",
        "**/index.ts",
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    globals: true,
    include: ["src/test/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
