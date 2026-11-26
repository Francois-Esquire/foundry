import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { file as bunFile, serve } from "bun";

export interface StaticSite {
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
