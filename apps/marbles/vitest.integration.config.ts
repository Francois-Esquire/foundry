import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    fileParallelism: false,
    // The run's root, fake HOME and process records, and the guard, as
    // the default suite has them; not the rest of its settings, whose
    // `exclude` names these very files.
    globalSetup: base.test?.globalSetup,
    hookTimeout: 240_000,
    include: ["test/**/*.integration.test.ts"],
    setupFiles: base.test?.setupFiles,
    testTimeout: 240_000,
  },
});
