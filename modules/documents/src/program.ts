import { file, serve, type WebSocketHandler } from "bun";

interface GatewayClient {
  call(alias: string, input: unknown): Promise<unknown>;
  observe(
    alias: string,
    input: unknown,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<unknown>;
}
interface ProgramGateway {
  readonly client: GatewayClient | undefined;
  readonly websocket: WebSocketHandler<undefined>;
}

const ARTIFACT_REQUESTS = new Set([
  "binding",
  "read",
  "save",
  "create",
  "files",
]);
const EXECUTION_REQUESTS = new Set(["start", "cancel"]);

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
      output: await client.call(body.alias, body.input),
    });
  } catch (error) {
    return Response.json({ code: failureCode(error), ok: false });
  }
}

function watchEntry(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const contentId = params.get("contentId");
  const digest = params.get("digest");
  const artifactId = params.get("artifactId");
  return observe(request, "watch", {
    ...(contentId && digest ? { after: { contentId, digest } } : {}),
    ...(artifactId ? { artifactId } : { binding: params.get("binding") ?? "" }),
  });
}

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
          } catch {
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
    if (path === "/_module/execution" && request.method === "POST") {
      return relay(request, EXECUTION_REQUESTS);
    }
    if (path === "/_module/execution/watch") {
      return observe(request, "runs", {
        execution: new URL(request.url).searchParams.get("execution") ?? "",
      });
    }
    if (path === "/") {
      return asset("./view.html", "text/html");
    }
    if (path === "/view.js") {
      return asset("./view.js", "text/javascript");
    }
    if (path === "/workflows") {
      return asset("./workflows.html", "text/html");
    }
    if (path === "/workflows.js") {
      return asset("./workflows.js", "text/javascript");
    }
    return new Response(null, { status: 404 });
  },
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  websocket: gateway.websocket,
});
process.stdout.write(`listening ${String(server.port)}\n`);
