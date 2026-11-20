import { defineConfig } from "vitest/config";

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
