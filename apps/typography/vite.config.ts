import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022" },
  // Both engines locate their WebAssembly next to their own module, which
  // dependency pre-bundling would break.
  optimizeDeps: { exclude: ["harfbuzzjs", "pyodide"] },
  plugins: [react()],
  resolve: { alias: { "~": path.join(import.meta.dirname, "src") } },
  worker: { format: "es" },
});
