import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    execArgv: ["--no-install"],
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["test/browser/**/*.test.ts"],

    server: { deps: { inline: ["zod"] } },
    testTimeout: 180_000,
  },
});
