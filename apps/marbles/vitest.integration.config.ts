import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

export default defineConfig({
  ...base,
  test: {
    fileParallelism: false,
    hookTimeout: 240_000,
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 240_000,
  },
});
