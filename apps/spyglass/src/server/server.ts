import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { hasErrorCode, isMissingPath } from "@foundry/lib/atomic-file";
import { COLLECTION_MANIFEST } from "../lib/dataset-layout";

interface CollectionData {
  datasets: ReadonlyMap<string, string>;
  manifest(): Promise<unknown>;
}

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
    if (isMissingPath(error) || hasErrorCode(error, "ENAMETOOLONG")) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

const RETRY_AFTER_SECONDS = 1;

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
