import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/test/**/*.test.ts"],
    // Spies are restored even when an assertion fails before cleanup.
    restoreMocks: true,
  },
});
