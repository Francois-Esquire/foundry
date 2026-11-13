import { existsSync } from "node:fs";
import { cp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

// The Spyglass scan page at /spyglass/scan/: the static page and its browser
// analysis asset exactly as `@foundry.sh/spyglass`'s build writes them to
// its dist/scan, copied whole into this site's build output. The page uses
// relative URLs, so it needs no rewriting here. Turbo builds Spyglass first
// (this site depends on it, and `build` waits for `^build`); nothing is
// copied into the source tree, so no generated file can go stale there.

/** Unlisted development route; deliberately absent from public links and sitemap. */
const SPYGLASS_SCAN_ROUTE = "/spyglass/scan/";

const ROUTE = SPYGLASS_SCAN_ROUTE.slice(1, -1).split("/");

/** The built page's files: the page and the asset it loads by URL. */
const REQUIRED = ["index.html", join("analysis", "spyglass-analysis.js")];

/** `@foundry.sh/spyglass`'s dist/scan, once built. */
function builtPage(): string {
  const require = createRequire(import.meta.url);
  let entry: string;
  try {
    // The library entry, dist/lib/index.js; the page is dist/scan.
    entry = require.resolve("@foundry.sh/spyglass");
  } catch (error) {
    throw new Error(
      "@foundry.sh/spyglass is not built; run `bun run build --filter=@foundry/website` so Turbo builds it first.",
      { cause: error }
    );
  }
  const page = join(dirname(entry), "..", "scan");
  const missing = REQUIRED.filter((file) => !existsSync(join(page, file)));
  if (missing.length > 0) {
    throw new Error(
      `The Spyglass scan page at ${page} is incomplete (missing ${missing.join(", ")}); rebuild @foundry.sh/spyglass.`
    );
  }
  return page;
}

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** The file under `page` a request path names, or undefined outside it. */
function fileIn(page: string, pathname: string): string | undefined {
  const relative = normalize(decodeURIComponent(pathname)).slice(1);
  if (relative === ".." || relative.startsWith(`..${sep}`)) {
    return;
  }
  return join(
    page,
    relative === "" || relative.endsWith(sep)
      ? join(relative, "index.html")
      : relative
  );
}

export function spyglassScan(): AstroIntegration {
  return {
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const page = builtPage();
        const target = join(fileURLToPath(dir), ...ROUTE);
        await rm(target, { force: true, recursive: true });
        await cp(page, target, { recursive: true });
        logger.info(`Spyglass scan page copied to ${SPYGLASS_SCAN_ROUTE}`);
      },
      // `astro dev` serves the built page in place, read on each request,
      // so a rebuild of Spyglass shows on reload. As for every route here
      // (`trailingSlash: "always"`), the page's URL ends in a slash.
      "astro:server:setup": ({ server }) => {
        server.middlewares.use(
          SPYGLASS_SCAN_ROUTE.slice(0, -1),
          async (request, response, next) => {
            const { pathname } = new URL(request.url ?? "/", "http://site");
            let page: string;
            try {
              page = builtPage();
            } catch (error) {
              response.writeHead(404, { "content-type": "text/plain" });
              response.end(String(error));
              return;
            }
            const file = fileIn(page, pathname);
            const body =
              file === undefined
                ? undefined
                : await readFile(file).catch(() => undefined);
            if (file === undefined || body === undefined) {
              next();
              return;
            }
            const type = TYPES[extname(file)];
            response.writeHead(
              200,
              type === undefined ? {} : { "content-type": type }
            );
            response.end(body);
          }
        );
      },
    },
    name: "spyglass-scan",
  };
}
