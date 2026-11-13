import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { noNodeBuiltins } from "./scripts/no-node-builtins";

// The viewer reads datasets through lib's browser-safe reader; a Node
// built-in reaching it fails the build.
export default defineConfig({
  base: "./",
  build: { emptyOutDir: true, outDir: "dist/web" },
  // `.wgsl` imports become prepared shader modules (`ShaderSource`), for
  // the WebGPU renderer under src/web/islands/.
  plugins: [noNodeBuiltins(), wgslVitePlugin(), react()],
  publicDir: "public",
  root: import.meta.dirname,
});
