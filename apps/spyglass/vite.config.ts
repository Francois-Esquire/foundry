import { resolve } from "node:path";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { noNodeBuiltins } from "./scripts/no-node-builtins";

// The viewer, or with `mode: "scan"` the scan page (src/web/scan), which
// draws with the viewer's components. Both read datasets through lib's
// browser-safe reader; a Node built-in reaching either fails the build.
export default defineConfig(({ mode }) => {
  const scan = mode === "scan";
  return {
    base: "./",
    build: {
      emptyOutDir: true,
      outDir: resolve(import.meta.dirname, scan ? "dist/scan" : "dist/web"),
    },
    // `.wgsl` imports become prepared shader modules (`ShaderSource`), for
    // the WebGPU renderer under src/web/islands/.
    plugins: [noNodeBuiltins(), wgslVitePlugin(), react()],
    publicDir: scan ? false : "public",
    root: scan
      ? resolve(import.meta.dirname, "src/web/scan")
      : import.meta.dirname,
  };
});
