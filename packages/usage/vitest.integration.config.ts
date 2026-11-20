import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/test/integration/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
