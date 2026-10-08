import type { ModulePreviews } from "./controller";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-src 'none'";

export function createPreviewProxy(
  previews: Pick<ModulePreviews, "endpoint">,
  fetchImplementation: typeof fetch = fetch
) {
  return async (request: Request): Promise<Response> => {
    const address = new URL(request.url);
    const endpoint = previews.endpoint(address.hostname);
    const path = previewPath(address);
    if (!endpoint || path === null) {
      return new Response(null, { status: 404 });
    }
    if (!allowedMethod(request.method, path)) {
      return new Response(null, { status: 405 });
    }
    if (!allowedPath(endpoint.views, path)) {
      return new Response(null, { status: 404 });
    }
    const origin = loopbackOrigin(endpoint.origin);
    if (!origin) {
      return new Response(null, { status: 502 });
    }
    const target = new URL(origin);
    target.pathname = address.pathname;
    target.search = address.search;
    try {
      const response = await fetchImplementation(target, {
        body:
          request.method === "POST" ? await request.arrayBuffer() : undefined,
        headers: {
          connection: "close",
          "content-type":
            request.headers.get("content-type") ?? "application/json",
        },
        method: request.method,
        redirect: "manual",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });
      if (!allowedResponse(response)) {
        return new Response(null, { status: 502 });
      }
      if (previews.endpoint(address.hostname) !== endpoint) {
        return new Response(null, { status: 409 });
      }
      const headers = new Headers();
      headers.set(
        "content-type",
        response.headers.get("content-type") ?? "application/octet-stream"
      );
      headers.set("Content-Security-Policy", CSP);
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      headers.set("cache-control", "no-store");
      return new Response(response.body, { headers, status: response.status });
    } catch {
      return new Response(null, { status: 502 });
    }
  };
}

function previewPath(address: URL): string | null {
  try {
    const path = decodeURIComponent(address.pathname);
    if (
      address.protocol !== "module-preview:" ||
      path.includes("\\") ||
      path.includes("\0") ||
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

function allowedMethod(method: string, path: string): boolean {
  return (
    method === "GET" ||
    method === "HEAD" ||
    (method === "POST" && path === "/_module/graphql")
  );
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

function allowedPath(views: { path: string }[], path: string): boolean {
  return (
    views.some((view) => view.path === path) ||
    path.slice(path.lastIndexOf("/") + 1).includes(".") ||
    path === "/_module/graphql"
  );
}
