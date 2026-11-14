import { resolve } from "node:path";
import { build, defaultClientConditions } from "vite";
import { browserCruiseAdapter } from "./browser-cruise-adapter";
import { noNodeBuiltins } from "./no-node-builtins";

process.env.NODE_ENV = "production";

const root = resolve(import.meta.dirname, "..");

await build({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(root, "src/lib/browser-analysis.ts"),
      fileName: "spyglass-analysis",
      formats: ["es"],
    },
    outDir: resolve(root, "dist/analysis"),
    reportCompressedSize: false,
    rolldownOptions: { output: { codeSplitting: false } },
    target: "es2022",
  },
  configFile: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  logLevel: "warn",
  plugins: [...browserCruiseAdapter(), noNodeBuiltins()],
  publicDir: false,
  resolve: { conditions: ["spyglass-browser", ...defaultClientConditions] },
  root,
});
