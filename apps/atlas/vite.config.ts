import { isBuiltin } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The id Vite gives the empty module it swaps in for a Node built-in. */
const BROWSER_EXTERNAL = "__vite-browser-external";

/**
 * The viewer reads the dataset through lib's browser-safe reader. A Node
 * built-in reaching the bundle becomes an empty stub that fails at runtime,
 * so importing one fails the build instead. A bare name such as `buffer` is
 * allowed when it resolves to a browser package.
 */
function noNodeBuiltins(): Plugin {
  return {
    enforce: "pre",
    name: "atlas:no-node-builtins",
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
  plugins: [noNodeBuiltins(), react()],
  publicDir: "public",
  root: import.meta.dirname,
});
