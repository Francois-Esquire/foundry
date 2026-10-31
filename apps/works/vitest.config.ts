import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "~": path.join(import.meta.dirname, "src") };
const AUDIT_TESTS = "test/app/modules-audit.test.tsx";

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
          exclude: [AUDIT_TESTS],
          include: ["test/app/**/*.test.{ts,tsx}"],
          name: "renderer",
          setupFiles: ["test/helpers/setup-dom.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          environment: "happy-dom",
          // The audit tabs render a real engine store, produced in Node
          // once before them; no other renderer test waits for it.
          globalSetup: ["test/helpers/audit-fixture.setup.ts"],
          include: [AUDIT_TESTS],
          name: "renderer-audit",
          setupFiles: ["test/helpers/setup-dom.ts"],
        },
      },
    ],
  },
});
