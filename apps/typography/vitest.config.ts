import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "~": path.join(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 120_000,
  },
});
