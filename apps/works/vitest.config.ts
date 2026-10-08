import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "~": path.join(import.meta.dirname, "src") };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          environment: "node",
          include: ["test/main/**/*.test.ts", "test/shared/**/*.test.ts"],
          name: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          environment: "happy-dom",
          include: ["test/app/**/*.test.{ts,tsx}"],
          name: "renderer",
          setupFiles: ["test/helpers/setup-dom.ts"],
        },
      },
    ],
  },
});
