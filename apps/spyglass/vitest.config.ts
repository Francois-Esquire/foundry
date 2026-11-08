import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // A test that reaches the Islands renderer through islands-host/ loads
  // its `.wgsl` imports as the build does (vite.config.ts).
  plugins: [wgslVitePlugin()],
  test: {
    // The package suite has a configuration of its own. The synced Islands
    // copy under src/web/islands ships no tests; this keeps any out.
    exclude: [
      "test/lib/fixtures/**",
      "test/package.test.ts",
      "src/web/islands/**",
    ],
    // Bun installs a package it cannot resolve unless told not to.
    execArgv: ["--no-install"],
    hookTimeout: 120_000,
    include: [
      "test/*.test.ts",
      "test/cli/**/*.test.ts",
      "test/lib/**/*.test.ts",
      "test/web/**/*.test.ts",
    ],
    maxWorkers: process.env.CI ? 2 : 4,
    // Vitest runs on Bun, which OpenTUI's renderer and `serve` need; Bun
    // drops zod's `z` export when Vitest imports it as an external module.
    server: { deps: { inline: ["zod"] } },
    testTimeout: 30_000,
  },
});
