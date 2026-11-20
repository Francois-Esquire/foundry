import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/test/**", "**/*.d.ts", "dist/**"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    projects: [
      {
        test: {
          exclude: ["src/test/**/*.integration.test.ts"],
          globals: true,
          include: ["src/test/**/*.test.ts"],
          name: "unit",
        },
      },
      {
        test: {
          globals: true,
          include: ["src/test/**/*.integration.test.ts"],
          name: "integration",
        },
      },
    ],
  },
});
