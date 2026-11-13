import { isBuiltin } from "node:module";
import type { Plugin } from "vite";

/** The id Vite gives the empty module it swaps in for a Node built-in. */
const BROWSER_EXTERNAL = "__vite-browser-external";

/**
 * Fails a browser build that imports a Node built-in. Vite would swap in an
 * empty stub that fails only at runtime, so importing one fails the build
 * instead. A bare name such as `buffer` is allowed when it resolves to a
 * browser package. The viewer builds with it, and so does the browser
 * analysis asset, after the cruise adapter has answered the built-ins it
 * replaces.
 */
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
