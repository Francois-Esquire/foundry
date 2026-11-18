import { isBuiltin } from "node:module";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const BROWSER_EXTERNAL = "__vite-browser-external";

function noNodeBuiltins(): Plugin {
  return {
    enforce: "pre",
    name: "spyglass:no-node-builtins",
    async resolveId(source, importer) {
      if (!isBuiltin(source)) {
        return null;
      }
      const resolved = source.startsWith("node:")
        ? null
        : await this.resolve(source, importer, { skipSelf: true });
      if (resolved === null || resolved.id.startsWith(BROWSER_EXTERNAL)) {
        this.error(
          `${importer ?? "The viewer"} imports ${source}, a Node built-in; the viewer runs in the browser.`
        );
      }
      return resolved;
    },
  };
}

export default defineConfig({
  base: "./",
  build: { emptyOutDir: true, outDir: "dist/web" },
  plugins: [noNodeBuiltins(), wgslVitePlugin(), react()],
  publicDir: "public",
  root: import.meta.dirname,
});
