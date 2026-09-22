import { defineConfig } from "vitest/config";

/**
 * Two projects, each run on purpose by its script. `unit` is the default
 * gate. `integration` boots real microsandbox VMs and needs the runtime
 * installed.
 */
export default defineConfig({
  test: {
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
