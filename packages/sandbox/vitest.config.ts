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
          maxWorkers: process.env.CI ? 2 : undefined,
          name: "unit",
          // Bun drops zod's `z` export when Vitest imports it as an external
          // module, so the suite inlines it to pass on Bun as well as Node.
          server: { deps: { inline: ["zod"] } },
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
