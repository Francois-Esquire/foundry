import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { file as bunFile, serve } from "bun";

// A static file host for a built site, mounted under a base path: `/` as
// foundry.sh is served, or `/foundry/` as GitHub Pages mounts the
// documentation site. Nothing is generated or proxied: a path is a file
// under `directory` or a 404.

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

export interface StaticSite {
  /** The site's origin, such as `http://127.0.0.1:51234`. */
  origin: string;
  stop(): void;
}

/** Serves `directory` at `base` (which starts and ends with `/`). */
export function serveStatic(directory: string, base: string): StaticSite {
  if (!existsSync(directory)) {
    throw new Error(`${directory} does not exist; build it first.`);
  }
  const server = serve({
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith(base)) {
        return new Response("Not found", { status: 404 });
      }
      const relative = normalize(
        decodeURIComponent(pathname.slice(base.length))
      );
      if (relative.startsWith("..")) {
        return new Response("Not found", { status: 404 });
      }
      const path = join(
        directory,
        relative.endsWith("/") || relative === "."
          ? join(relative, "index.html")
          : relative
      );
      const file = bunFile(path);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      const type = TYPES[extname(path)];
      return new Response(
        file,
        type === undefined ? {} : { headers: { "content-type": type } }
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return { origin: server.url.origin, stop: () => server.stop(true) };
}
