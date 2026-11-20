import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    fileParallelism: false,
    globalSetup: base.test?.globalSetup,
    hookTimeout: 240_000,
    include: ["test/**/*.integration.test.ts"],
    setupFiles: base.test?.setupFiles,
    testTimeout: 240_000,
  },
});
