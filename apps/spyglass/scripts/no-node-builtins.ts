import { isBuiltin } from "node:module";
import type { Plugin } from "vite";

const BROWSER_EXTERNAL = "__vite-browser-external";

export function noNodeBuiltins(): Plugin {
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
          `${importer ?? "The bundle"} imports ${source}, a Node built-in; this bundle runs in the browser.`
        );
      }
      return resolved;
    },
  };
}
