import { resolve } from "node:path";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { noNodeBuiltins } from "./scripts/no-node-builtins";

export default defineConfig({
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, "dist/web"),
  },

  plugins: [noNodeBuiltins(), wgslVitePlugin(), react()],
  root: import.meta.dirname,
});
