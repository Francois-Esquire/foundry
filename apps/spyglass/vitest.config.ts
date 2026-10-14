import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["test/lib/fixtures/**"],
    hookTimeout: 120_000,
    include: [
      "test/cli/**/*.test.ts",
      "test/lib/**/*.test.ts",
      "test/web/**/*.test.ts",
    ],
    maxWorkers: process.env.CI ? 2 : 4,
    testTimeout: 30_000,
  },
});
