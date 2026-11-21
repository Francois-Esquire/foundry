import { resolve } from "node:path";
import { build, defaultClientConditions } from "vite";
import { browserCruiseAdapter } from "./browser-cruise-adapter";

process.env.NODE_ENV = "production";

const root = resolve(import.meta.dirname, "..");

await build({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(root, "src/lib/file-map-cruise-engine.ts"),
      fileName: "file-map-cruise-engine",
      formats: ["es"],
    },
    minify: false,
    outDir: resolve(root, "dist/engine"),

    rolldownOptions: {
      external: ["typescript"],
      output: { codeSplitting: false },
    },
    target: "esnext",
  },
  configFile: false,
  logLevel: "warn",
  plugins: browserCruiseAdapter(),
  publicDir: false,
  resolve: { conditions: ["spyglass-browser", ...defaultClientConditions] },
  root,
});
