/**
 * The static file server: the data under `/data/`, the viewer elsewhere.
 * The data is one workspace's output, or a collection: its manifest,
 * derived on each request, and each workspace's output under its id.
 *
 * It calls `globalThis.Bun` where it needs it, not `import … from "bun"`: the
 * bundler turns a top-level import from "bun" into a destructure of
 * `globalThis.Bun` that throws as the module loads under Node, and that would
 * break importing `scan` from the library entry. `serve` checks for Bun
 * before it gets here.
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { hasErrorCode, isMissingPath } from "@foundry/lib/atomic-file";
import { COLLECTION_MANIFEST } from "../lib/dataset-layout";

/** What `/data/` serves for a collection: `lib/dataset-files.ts` `savedCollection`. */
interface CollectionData {
  /** Each workspace's output, by its id; `/data/<id>/…` serves it, and an id not here is not found. */
  datasets: ReadonlyMap<string, string>;
  /** The collection manifest, derived when asked; `/data/collection-manifest.json` serves it. A rejection names the workspace whose dataset could not be read. */
  manifest(): Promise<unknown>;
}

/** One workspace's output, or a collection's data; never both. */
type DataOptions =
  | { collection?: never; output: string }
  | { collection: CollectionData; output?: never };

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
    // A name longer than the filesystem allows names no file either.
    if (isMissingPath(error) || hasErrorCode(error, "ENAMETOOLONG")) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}

/**
 * The names a request may address the server by. It listens on 127.0.0.1
 * only; a request naming any other host reached it through a name that
 * merely resolves there, and is refused. Any port is accepted, so a
 * forwarded port still works.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

/** Seconds a client waits before asking again for a manifest a workspace could not give. */
const RETRY_AFTER_SECONDS = 1;

/**
 * The collection manifest, derived now. A workspace whose dataset cannot be
 * read (deleted, caught mid-swap by a scan, or of another schema) makes it
 * 503 with `Retry-After`, the message naming the workspace, rather than an
 * error: a scan may be about to put it back.
 */
async function collectionManifestResponse(
  collection: CollectionData
): Promise<Response> {
  let manifest: unknown;
  try {
    manifest = await collection.manifest();
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      {
        headers: { "Retry-After": String(RETRY_AFTER_SECONDS) },
        status: 503,
      }
    );
  }
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/json;charset=utf-8" },
  });
}

/** A collection's data: its manifest, or a file of one workspace's dataset by the id that leads the path. */
async function serveCollection(
  collection: CollectionData,
  pathname: string
): Promise<Response> {
  if (pathname === `/${COLLECTION_MANIFEST}`) {
    return await collectionManifestResponse(collection);
  }
  const [, id = "", ...rest] = pathname.split("/");
  const output = collection.datasets.get(id);
  if (output === undefined) {
    return new Response("Not found", { status: 404 });
  }
  return serveFile(output, `/${rest.join("/")}`);
}

/**
 * The decoded path a request asks for, or the response that refuses it: a
 * host other than the loopback names, a method other than GET and HEAD, or
 * a path that does not decode or holds a NUL or a backslash.
 */
function requestedPath(request: Request): string | Response {
  const url = URL.parse(request.url);
  if (!(url && LOOPBACK_HOSTNAMES.has(url.hostname))) {
    return new Response(
      "Spyglass answers only requests addressed to 127.0.0.1 or localhost.",
      { status: 403 }
    );
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      headers: { Allow: "GET, HEAD" },
      status: 405,
    });
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }
  if (pathname.includes("\0") || pathname.includes("\\")) {
    return new Response("Invalid path", { status: 400 });
  }
  return pathname;
}

export function startServer(
  options: DataOptions & {
    port: number;
    /** The viewer's built files; without them only `/data/` is served. */
    viewer?: string;
  }
) {
  return globalThis.Bun.serve({
    error(error) {
      process.stderr.write(`Spyglass server: ${error.message}\n`);
      return new Response("Spyglass could not read the requested file.", {
        status: 500,
      });
    },
    async fetch(request) {
      const pathname = requestedPath(request);
      if (pathname instanceof Response) {
        return pathname;
      }
      let response: Response;
      if (pathname.startsWith("/data/")) {
        const path = pathname.slice("/data".length);
        response =
          options.collection === undefined
            ? await serveFile(options.output, path)
            : await serveCollection(options.collection, path);
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
