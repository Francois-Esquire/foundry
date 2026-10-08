import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";

const src = path.join(import.meta.dirname, "src");
const electron = ["electron", "electron/main", "electron/common"];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      outDir: "dist/main",
      rollupOptions: {
        external: electron,
        input: { index: path.join(src, "main/index.ts") },
        output: {
          chunkFileNames: "chunks/[name]-[hash].js",
          entryFileNames: "[name].js",
          format: "es",
        },
      },
    },
    resolve: { alias: { "~": src } },
  },
  preload: {
    build: {
      externalizeDeps: false,
      outDir: "dist/preload",
      rollupOptions: {
        external: electron,
        input: { index: path.join(src, "preload.ts") },
        // The sandboxed preload cannot run ESM, so it stays CommonJS.
        output: {
          chunkFileNames: "chunks/[name]-[hash].cjs",
          entryFileNames: "[name].cjs",
          format: "cjs",
        },
      },
    },
    resolve: { alias: { "~": src } },
  },
  renderer: {
    base: "./",
    build: {
      outDir: "dist/renderer",
      rollupOptions: { input: path.join(import.meta.dirname, "index.html") },
    },
    plugins: [tailwindcss()],
    resolve: { alias: { "~": src } },
    root: ".",
  },
});
