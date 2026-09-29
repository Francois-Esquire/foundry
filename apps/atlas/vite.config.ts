import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { emptyOutDir: true, outDir: "dist/web" },
  plugins: [react()],
  publicDir: "public",
  root: import.meta.dirname,
});
