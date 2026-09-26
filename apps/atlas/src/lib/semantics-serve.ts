import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

// V12.0 static server: GET files beneath one directory (`.foundry/` by
// default), nothing else. No analysis, no API, no fallback routing; a path
// that resolves outside the root is a 404 like any other miss.

export interface SemanticsServerOptions {
  /**
   * Optional prototype directory consulted before `root` for every path
   * outside `/semantics/`, so a committed client can sit beside the
   * gitignored dataset.
   */
  app?: string;
  host?: string;
  port?: number;
  /** Directory served at `/`. */
  root: string;
}

export interface SemanticsServer {
  close(): Promise<void>;
  listen(): Promise<{ host: string; port: number; url: string }>;
  root: string;
}

export const DEFAULT_SEMANTICS_HOST = "127.0.0.1";
export const DEFAULT_SEMANTICS_PORT = 4173;

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const MISSING_INDEX =
  "No index.html found.\nSemantics dataset available at /semantics/manifest.json.\n";

/** Maps a request path to a real file under `root`, or undefined when it escapes or is absent. */
export function resolveServedFile(
  root: string,
  requestPath: string
): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath.split("?")[0] ?? "");
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) {
    return undefined;
  }
  const base = fs.realpathSync(root);
  const resolved = path.resolve(
    base,
    `.${path.posix.normalize(`/${decoded}`)}`
  );
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return undefined;
  }
  if (!fs.existsSync(resolved)) {
    return undefined;
  }
  const real = fs.realpathSync(resolved);
  if (real !== base && !real.startsWith(base + path.sep)) {
    return undefined;
  }
  return real;
}

export function createSemanticsServer(
  options: SemanticsServerOptions
): SemanticsServer {
  const root = path.resolve(options.root);
  const app = options.app === undefined ? undefined : path.resolve(options.app);
  const host = options.host ?? DEFAULT_SEMANTICS_HOST;
  const port = options.port ?? DEFAULT_SEMANTICS_PORT;

  const resolve = (url: string): { file: string; base: string } | undefined => {
    const pathname = url.split("?")[0] ?? "/";
    if (app !== undefined && !pathname.startsWith("/semantics/")) {
      const file = resolveServedFile(app, url);
      if (
        file !== undefined &&
        (!fs.statSync(file).isDirectory() ||
          fs.existsSync(path.join(file, "index.html")))
      ) {
        return { base: app, file };
      }
    }
    const file = resolveServedFile(root, url);
    return file === undefined ? undefined : { base: root, file };
  };

  const server = http.createServer((request, response) => {
    const send = (status: number, type: string, body: string | Buffer) => {
      response.writeHead(status, {
        "Cache-Control": "no-cache",
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": type,
      });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(405, "text/plain; charset=utf-8", "Method Not Allowed\n");
      return;
    }
    const hit = resolve(request.url ?? "/");
    if (hit === undefined) {
      send(404, "text/plain; charset=utf-8", "Not Found\n");
      return;
    }
    const { file, base } = hit;
    if (fs.statSync(file).isDirectory()) {
      const index = path.join(file, "index.html");
      if (fs.existsSync(index) && fs.statSync(index).isFile()) {
        send(200, "text/html; charset=utf-8", fs.readFileSync(index));
      } else if (file === fs.realpathSync(base)) {
        send(200, "text/plain; charset=utf-8", MISSING_INDEX);
      } else {
        send(404, "text/plain; charset=utf-8", "Not Found\n");
      }
      return;
    }
    const type =
      MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    send(200, type, fs.readFileSync(file));
  });

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address() as AddressInfo;
          resolve({
            host: address.address,
            port: address.port,
            url: `http://${address.address}:${address.port}`,
          });
        });
      }),
    root,
  };
}
