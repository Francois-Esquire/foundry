import { cp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

// The Spyglass scan page at /spyglass/scan/: `@foundry.sh/spyglass`'s
// dist/scan, built with relative URLs, copied into this site's output and
// served from there by `astro dev`. Turbo builds Spyglass first.

const ROUTE = "/spyglass/scan";

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

/** dist/scan, beside the library entry's dist/lib. */
function builtPage(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@foundry.sh/spyglass")), "..", "scan");
}

export function spyglassScan(): AstroIntegration {
  return {
    hooks: {
      "astro:build:done": async ({ dir }) => {
        await cp(builtPage(), join(fileURLToPath(dir), ROUTE), {
          recursive: true,
        });
      },
      // Read on each request, so a rebuild of Spyglass shows on reload.
      "astro:server:setup": ({ server }) => {
        server.middlewares.use(ROUTE, async (request, response, next) => {
          let file: string;
          let body: Buffer;
          try {
            const decoded = decodeURIComponent(
              new URL(request.url ?? "/", "http://site").pathname
            );
            if (decoded.includes("\\")) {
              next();
              return;
            }
            // URL paths use forward slashes, including on Windows.
            const path = posix.normalize(decoded).slice(1);
            file = join(
              builtPage(),
              path === "" || path.endsWith("/")
                ? join(path, "index.html")
                : path
            );
            body = await readFile(file);
          } catch {
            // Unbuilt, malformed or missing: Astro's own 404.
            next();
            return;
          }
          const type = TYPES[extname(file)];
          response.writeHead(
            200,
            type === undefined ? {} : { "content-type": type }
          );
          response.end(body);
        });
      },
    },
    name: "spyglass-scan",
  };
}
