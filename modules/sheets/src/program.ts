/**
 * The Sheets Module's Program. Works connects to it over the Module
 * Gateway; its View reaches it only through the routes Works' proxy allows:
 * `POST /_module/artifacts` for binding, read, save and create, and
 * `GET /_module/artifacts/watch` for an entry's changes. Workbooks are
 * calculated in the View; the Program only serves it and relays its
 * requests, each checked by the host.
 */

import { file, serve, type WebSocketHandler } from "bun";

/** The parts of the Module SDK (`outputs/sdk.js`) this Program uses. */
interface GatewayClient {
  call(
    alias: string,
    input: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
  observe(
    alias: string,
    input: unknown,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<unknown>;
}
interface ProgramGateway {
  readonly client: GatewayClient | undefined;
  /** Bun `websocket` handlers for the host's Gateway socket. */
  readonly websocket: WebSocketHandler<undefined>;
}

const TERMINAL_WATCH_FAILURES = new Set([
  "unauthorized",
  "unknown-alias",
  "unknown-capability",
  "stale-runtime",
  "cancelled",
]);
/** The requests a View may relay per route; each is an alias the Manifest selects. */
const ARTIFACT_REQUESTS = new Set(["binding", "read", "save", "create"]);

const sdk = (await import(new URL("./sdk.js", import.meta.url).href)) as {
  createProgramGateway(): ProgramGateway;
};
const gateway = sdk.createProgramGateway();

const asset = (name: string, type: string) =>
  new Response(file(new URL(name, import.meta.url)), {
    headers: { "content-type": type },
  });

function failureCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "provider-failure";
}

/** One Gateway call; the answer is always 200 so the proxy passes it on. */
async function relay(
  request: Request,
  relayed: ReadonlySet<string>
): Promise<Response> {
  const { client } = gateway;
  if (!client) {
    return Response.json({ code: "transport-closed", ok: false });
  }
  const body = (await request.json().catch(() => null)) as {
    alias?: unknown;
    input?: unknown;
  } | null;
  if (!(typeof body?.alias === "string" && relayed.has(body.alias))) {
    return Response.json({ code: "unknown-alias", ok: false });
  }
  try {
    return Response.json({
      ok: true,
      output: await client.call(body.alias, body.input, {
        signal: request.signal,
      }),
    });
  } catch (error) {
    return Response.json({ code: failureCode(error), ok: false });
  }
}

/** The bound entry's watch, resumed after the state the View last saw. */
function watchEntry(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const contentId = params.get("contentId");
  const digest = params.get("digest");
  return observe(request, "watch", {
    ...(contentId && digest ? { after: { contentId, digest } } : {}),
    binding: params.get("binding") ?? "",
  });
}

/** One Gateway stream as server-sent events, one event per update. */
function observe(request: Request, alias: string, input: unknown): Response {
  const { client } = gateway;
  if (!client) {
    return new Response(null, { status: 503 });
  }
  const controller = new AbortController();
  request.signal.addEventListener("abort", () => controller.abort(), {
    once: true,
  });
  const events = client
    .observe(alias, input, { signal: controller.signal })
    [Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        cancel() {
          controller.abort();
        },
        async pull(stream) {
          try {
            const next = await events.next();
            if (next.done) {
              stream.close();
              return;
            }
            stream.enqueue(
              encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`)
            );
          } catch (error) {
            const code = failureCode(error);
            const terminal = TERMINAL_WATCH_FAILURES.has(code);
            stream.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  kind: "unavailable",
                  message: terminal
                    ? "Live updates are unavailable: access was denied. Reopen the workbook after restoring access."
                    : "Live updates are disconnected. Reconnecting…",
                  terminal,
                })}\n\n`
              )
            );
            stream.close();
          }
        },
      },
      { highWaterMark: 0 }
    ),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
      },
    }
  );
}

const server = serve({
  fetch(request, bun) {
    const path = new URL(request.url).pathname;
    if (path === "/_foundry/module-gateway" && bun.upgrade(request)) {
      return;
    }
    if (path === "/_foundry/health") {
      return new Response("ok");
    }
    if (path === "/_module/artifacts" && request.method === "POST") {
      return relay(request, ARTIFACT_REQUESTS);
    }
    if (path === "/_module/artifacts/watch") {
      return watchEntry(request);
    }
    if (path === "/") {
      return asset("./view.html", "text/html");
    }
    if (path === "/view.js") {
      return asset("./view.js", "text/javascript");
    }
    return new Response(null, { status: 404 });
  },
  hostname: process.env.MODULE_HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  websocket: gateway.websocket,
});
process.stdout.write(`listening ${String(server.port)}\n`);
