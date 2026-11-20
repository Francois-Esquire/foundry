import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [wgslVitePlugin()],
  test: {
    exclude: [
      "test/lib/fixtures/**",
      "test/package.test.ts",
      "src/web/islands/**",
    ],
    execArgv: ["--no-install"],
    hookTimeout: 120_000,
    include: [
      "test/*.test.ts",
      "test/cli/**/*.test.ts",
      "test/lib/**/*.test.ts",
      "test/web/**/*.test.ts",
    ],
    maxWorkers: process.env.CI ? 2 : 4,
    server: { deps: { inline: ["zod"] } },
    testTimeout: 30_000,
  },
});
