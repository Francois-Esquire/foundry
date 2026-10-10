/**
 * The static file server: the dataset under `/data/`, the viewer elsewhere.
 *
 * It calls `globalThis.Bun` where it needs it, not `import … from "bun"`: the
 * bundler turns a top-level import from "bun" into a destructure of
 * `globalThis.Bun` that throws as the module loads under Node, and that would
 * break importing `scan` from the library entry. `serve` checks for Bun
 * before it gets here.
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isMissingPath } from "@foundry/lib/atomic-file";

async function serveFile(
  directory: string,
  pathname: string
): Promise<Response> {
  try {
    const base = await realpath(directory);
    const file = await realpath(resolve(base, `.${pathname}`));
    const path = relative(base, file);
    if (
      path.startsWith("..") ||
      isAbsolute(path) ||
      !(await stat(file)).isFile()
    ) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(globalThis.Bun.file(file));
  } catch (error) {
    if (isMissingPath(error)) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}

export function startServer(options: {
  output: string;
  port: number;
  /** The viewer's built files; without them only `/data/` is served. */
  viewer?: string;
}) {
  return globalThis.Bun.serve({
    error(error) {
      process.stderr.write(`Atlas server: ${error.message}\n`);
      return new Response("Atlas could not read the requested file.", {
        status: 500,
      });
    },
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
          headers: { Allow: "GET, HEAD" },
          status: 405,
        });
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return new Response("Invalid path", { status: 400 });
      }
      if (pathname.includes("\0") || pathname.includes("\\")) {
        return new Response("Invalid path", { status: 400 });
      }
      let response: Response;
      if (pathname.startsWith("/data/")) {
        response = await serveFile(options.output, pathname.slice(5));
        response.headers.set("Cache-Control", "no-store");
      } else if (options.viewer) {
        response = await serveFile(
          options.viewer,
          pathname === "/" ? "/index.html" : pathname
        );
      } else {
        response = new Response("Not found", { status: 404 });
      }
      if (request.method === "HEAD") {
        return new Response(null, {
          headers: response.headers,
          status: response.status,
        });
      }
      return response;
    },
    hostname: "127.0.0.1",
    port: options.port,
  });
}
