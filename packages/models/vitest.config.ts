import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html"],
    },
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          exclude: ["src/test/**/*-vendor.test.ts"],
          include: ["src/test/**/*.test.ts"],
          name: "unit",
        },
      },
      {
        extends: true,
        test: {
          include: ["src/test/**/*-vendor.test.ts"],
          name: "integration",
        },
      },
    ],
    server: {
      deps: {
        inline: [/@huggingface\/transformers/, /@browser-ai\//],
      },
    },
  },
});
