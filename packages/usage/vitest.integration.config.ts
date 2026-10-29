import { defineConfig } from "vitest/config";

/** Live reads of this machine's own logins; each skips when it is not signed in. */
export default defineConfig({
  test: {
    globals: true,
    include: ["src/test/integration/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
