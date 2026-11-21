import type { ModuleEndpoint } from "./controller";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-src 'none'";

const REQUEST_TIMEOUT_MS = 10_000;

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

class BodyTooLargeError extends Error {}

type Lifetime = "request" | "stream";

const PROGRAM_PREFIX = "/_module/";

function lifetimeOf(path: string, request: Request): Lifetime | null {
  const program = path.startsWith(PROGRAM_PREFIX);
  switch (request.method) {
    case "GET":
      return program && asksForEvents(request) ? "stream" : "request";
    case "HEAD":
      return "request";
    case "POST":
      return program ? "request" : null;
    default:
      return null;
  }
}

function asksForEvents(request: Request): boolean {
  return (request.headers.get("accept") ?? "")
    .split(",")
    .some(
      (range) =>
        range.split(";")[0]?.trim().toLowerCase() === "text/event-stream"
    );
}

function upstreamHeaders(
  request: Request,
  lifetime: Lifetime
): Record<string, string> {
  const accept = request.headers.get("accept");
  return {
    ...(accept === null ? {} : { accept }),
    ...(lifetime === "request" ? { connection: "close" } : {}),
    ...(request.method === "POST"
      ? {
          "content-type":
            request.headers.get("content-type") ?? "application/json",
        }
      : {}),
  };
}

type Endpoint = Pick<ModuleEndpoint, "origin" | "signal" | "views">;

export function createModuleProxy(
  sessions: { endpoint(token: string): Endpoint | undefined },
  fetchImplementation: typeof fetch = fetch
) {
  return async (request: Request): Promise<Response> => {
    const address = new URL(request.url);
    const endpoint = sessions.endpoint(address.hostname);
    const admitted = admit(request, address, endpoint);
    if (admitted instanceof Response) {
      return admitted;
    }
    const { target } = admitted;
    const lifetime = responseLifetime(
      admitted.lifetime,
      request,
      admitted.endpoint
    );
    try {
      const body =
        request.method === "POST"
          ? await readBody(request, lifetime.signal)
          : undefined;
      const response = await lifetime.connect(
        fetchImplementation(target, {
          body,
          headers: upstreamHeaders(request, admitted.lifetime),
          method: request.method,
          redirect: "manual",
          signal: lifetime.signal,
        })
      );
      if (!allowedResponse(response)) {
        lifetime.end();
        return new Response(null, { status: 502 });
      }
      if (sessions.endpoint(address.hostname) !== endpoint) {
        lifetime.end();
        return new Response(null, { status: 409 });
      }
      return new Response(lifetime.body(response.body), {
        headers: isolatedHeaders(response),
        status: response.status,
      });
    } catch (error) {
      lifetime.end();
      return new Response(null, {
        status: error instanceof BodyTooLargeError ? 413 : 502,
      });
    }
  };
}

async function readBody(
  request: Request,
  signal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function admit(
  request: Request,
  address: URL,
  endpoint: Endpoint | undefined
): Response | { endpoint: Endpoint; lifetime: Lifetime; target: URL } {
  const path = modulePath(address);
  if (!endpoint || path === null) {
    return new Response(null, { status: 404 });
  }
  const lifetime = lifetimeOf(path, request);
  if (!lifetime) {
    return new Response(null, { status: 405 });
  }
  if (!(path.startsWith(PROGRAM_PREFIX) || staticPath(endpoint.views, path))) {
    return new Response(null, { status: 404 });
  }
  const origin = loopbackOrigin(endpoint.origin);
  if (!origin) {
    return new Response(null, { status: 502 });
  }
  const target = new URL(origin);
  target.pathname = path.split("/").map(encodeURIComponent).join("/");
  target.search = address.search;
  return { endpoint, lifetime, target };
}

function isolatedHeaders(response: Response): Headers {
  const headers = new Headers();
  headers.set(
    "content-type",
    response.headers.get("content-type") ?? "application/octet-stream"
  );
  headers.set("Content-Security-Policy", CSP);
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("cache-control", "no-store");
  return headers;
}

function responseLifetime(
  lifetime: Lifetime,
  request: Request,
  endpoint: Endpoint
) {
  if (lifetime === "request") {
    return {
      body: (body: ReadableStream<Uint8Array> | null) => body,
      connect: (response: Promise<Response>) => response,
      end: () => undefined,
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    };
  }
  const controller = new AbortController();
  const sources = [request.signal, endpoint.signal];
  const end = () => {
    for (const source of sources) {
      source.removeEventListener("abort", end);
    }
    controller.abort();
  };
  for (const source of sources) {
    if (source.aborted) {
      end();
    }
    source.addEventListener("abort", end, { once: true });
  }
  return {
    body(body: ReadableStream<Uint8Array> | null) {
      if (!body) {
        end();
        return null;
      }
      const reader = body.getReader();
      return new ReadableStream<Uint8Array>(
        {
          cancel() {
            end();
          },
          async pull(stream) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                stream.close();
                end();
              } else {
                stream.enqueue(value);
              }
            } catch (error) {
              end();
              settle(() => stream.error(error));
            }
          },
          start(stream) {
            controller.signal.addEventListener(
              "abort",
              () => {
                reader.cancel().catch(() => undefined);
                settle(() =>
                  stream.error(new Error("The Module app stopped serving"))
                );
              },
              { once: true }
            );
          },
        },
        { highWaterMark: 0 }
      );
    },
    async connect(response: Promise<Response>): Promise<Response> {
      const timer = setTimeout(end, REQUEST_TIMEOUT_MS);
      try {
        return await response;
      } finally {
        clearTimeout(timer);
      }
    },
    end,
    signal: controller.signal,
  };
}

function settle(action: () => void): void {
  try {
    action();
  } catch {
    // Already closed, errored or cancelled.
  }
}

function modulePath(address: URL): string | null {
  try {
    const path = decodeURIComponent(address.pathname);
    if (
      address.protocol !== "module-app:" ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.includes("//") ||
      path.split("/").includes("..") ||
      path.startsWith("/_foundry") ||
      path.startsWith("/_module/gateway")
    ) {
      return null;
    }
    return path;
  } catch {
    return null;
  }
}

function loopbackOrigin(value: string): URL | null {
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) ||
      origin.username ||
      origin.password
    ) {
      return null;
    }
    return origin;
  } catch {
    return null;
  }
}

function allowedResponse(response: Response): boolean {
  return (
    response.status < 300 &&
    !response.headers.has("location") &&
    !response.headers.has("content-security-policy")
  );
}

function staticPath(views: { path: string }[], path: string): boolean {
  return (
    views.some((view) => view.path === path) ||
    path.slice(path.lastIndexOf("/") + 1).includes(".")
  );
}
