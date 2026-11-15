import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/**/*.d.ts", "src/**/index.ts", "src/**/types.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
    },
    globals: true,
    include: ["src/test/**/*.test.ts"],
    // Bun drops zod's `z` export when Vitest imports it as an external
    // module, so the suite inlines it to pass on Bun as well as Node.
    server: { deps: { inline: ["zod"] } },
  },
});
