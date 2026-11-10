import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The default suite: fast, offline once the engine wheels are cached. Tests
 * that need native tools, the network or a browser live in test/integration
 * and test/e2e and run from their own scripts. Component tests opt into a DOM
 * with a `@vitest-environment happy-dom` docblock.
 */
export default defineConfig({
  resolve: { alias: { "~": path.join(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    exclude: ["test/integration/**", "test/e2e/**"],
    hookTimeout: 120_000,
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 60_000,
  },
});
