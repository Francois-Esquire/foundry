import path from "node:path";
import { defineConfig } from "vitest/config";

/** Checks that need native tools (uv, fontTools, OTS), the network or Chrome. */
export default defineConfig({
  resolve: { alias: { "~": path.join(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["test/integration/**/*.test.ts", "test/e2e/**/*.test.ts"],
    testTimeout: 180_000,
  },
});
