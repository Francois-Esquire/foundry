import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { file as bunFile, serve } from "bun";

// A static file host for a built site. Nothing is generated or proxied: a
// path is a file under `directory` (typed by Bun from its extension) or a
// 404.

export interface StaticSite {
  /** The site's origin, such as `http://127.0.0.1:51234`. */
  origin: string;
  stop(): void;
}

export function serveStatic(directory: string): StaticSite {
  if (!existsSync(directory)) {
    throw new Error(`${directory} does not exist; build it first.`);
  }
  const server = serve({
    async fetch(request) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return new Response("Invalid path", { status: 400 });
      }
      if (decoded.includes("\\")) {
        return new Response("Invalid path", { status: 400 });
      }
      // URL paths use forward slashes, including on Windows.
      const relative = posix.normalize(decoded).slice(1);
      const path = join(
        directory,
        relative === "" || relative.endsWith("/")
          ? join(relative, "index.html")
          : relative
      );
      const file = bunFile(path);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(file);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return { origin: server.url.origin, stop: () => server.stop(true) };
}
