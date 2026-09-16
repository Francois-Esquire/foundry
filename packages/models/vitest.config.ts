import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    exclude: ["src/test/**/*-vendor.test.ts"],
    globals: true,
    include: ["src/test/**/*.test.ts"],
    server: {
      deps: {
        inline: [/@huggingface\/transformers/, /@browser-ai\//],
      },
    },
  },
});
