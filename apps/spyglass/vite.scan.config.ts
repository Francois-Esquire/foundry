import { resolve } from "node:path";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { noNodeBuiltins } from "./scripts/no-node-builtins";

// The scan page (src/web/scan): the viewer's own components around a form
// that scans a public GitHub repository in the browser. Built to dist/scan
// with relative URLs, so a site can serve it under any path. The analysis
// asset is built separately into dist/scan/analysis (scripts/build.ts) and
// loaded by URL; this build never resolves it, and the viewer's
// Node-builtin guard applies to the page as it does to the viewer.
export default defineConfig({
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, "dist/scan"),
  },
  // The page draws with the viewer's Islands renderer, whose `.wgsl`
  // imports load as in vite.config.ts.
  plugins: [noNodeBuiltins(), wgslVitePlugin(), react()],
  publicDir: false,
  root: resolve(import.meta.dirname, "src/web/scan"),
});
