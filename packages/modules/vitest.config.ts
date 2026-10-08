import { defineConfig } from "vitest/config";

/**
 * Two projects, each run on purpose by its script. `unit` is the default
 * gate. `integration` installs, builds, and serves a generated Module
 * workspace with real processes, and also needs
 * FOUNDRY_RUN_GENERATED_MODULE_WORKSPACE=1.
 */
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
