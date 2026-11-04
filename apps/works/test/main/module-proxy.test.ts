import { afterEach, describe, expect, it, vi } from "vitest";
import { createModuleProxy } from "~/main/modules/runtime/proxy";

const ORIGIN = "module-app://token";
/** What a View's event-stream watch asks for, as `EventSource` does. */
const EVENTS = { headers: { accept: "text/event-stream" } };

function endpoint() {
  const serving = new AbortController();
  return {
    serving,
    value: {
      origin: "http://127.0.0.1:3000",
      signal: serving.signal,
      views: [{ id: "main", path: "/" }],
    },
  };
}

/** An upstream that answers with `respond` and records each request. */
function upstream(
  respond: (init?: RequestInit) => Response | Promise<Response>
) {
  const calls: { init?: RequestInit; url: string }[] = [];
  const fetcher = vi.fn<typeof fetch>((url, init) => {
    calls.push({ init, url: String(url) });
    return Promise.resolve(respond(init));
  });
  return { calls, fetcher };
}

/** A stream body the test writes to; it reports when it is cancelled. */
function eventBody() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    cancel: cancelled,
    start(start) {
      controller = start;
    },
  });
  return {
    body,
    cancelled,
    write: (text: string) => controller?.enqueue(encoder.encode(text)),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Module proxy routes", () => {
  it("never reaches a private path, whatever the method", async () => {
    const { value } = endpoint();
    const { fetcher } = upstream(() => new Response("leak"));
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    for (const path of [
      "/_foundry/module-gateway",
      "/_foundry/health",
      "/_foundry/module-gateway.js",
      "/%5Ffoundry/module-gateway",
      "/_module/gateway",
    ]) {
      for (const method of ["GET", "POST", "HEAD"]) {
        const response = await proxy(
          new Request(`${ORIGIN}${path}`, { method })
        );
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards a View's /_module/ calls whatever the path: event-stream GETs as streams, the rest as requests", async () => {
    const { value } = endpoint();
    const { calls, fetcher } = upstream(() => new Response("ok"));
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    const status = async (method: string, path: string, init = {}) =>
      (
        await proxy(
          new Request(`${ORIGIN}${path}`, {
            body: method === "POST" ? "{}" : undefined,
            method,
            ...init,
          })
        )
      ).status;
    for (const path of [
      "/_module/graphql",
      "/_module/theme",
      "/_module/artifacts",
      "/_module/artifacts/watch",
      "/_module/execution/watch",
      "/_module/assets/app.js",
    ]) {
      expect(await status("POST", path), `POST ${path}`).toBe(200);
      expect(await status("GET", path), `GET ${path}`).toBe(200);
      expect(await status("GET", path, EVENTS), `GET ${path}`).toBe(200);
      expect(await status("HEAD", path), `HEAD ${path}`).toBe(200);
      expect(await status("PUT", path), `PUT ${path}`).toBe(405);
    }
    // The View's own accept decides: only an event-stream GET is a stream.
    // The Program sees what the View accepts, never one forced on it.
    const [post, get, stream, head] = calls.map(
      (call) => new Headers(call.init?.headers)
    );
    expect(post?.get("connection")).toBe("close");
    expect(get?.get("connection")).toBe("close");
    expect(get?.has("accept")).toBe(false);
    expect(stream?.has("connection")).toBe(false);
    expect(stream?.get("accept")).toBe("text/event-stream");
    expect(head?.get("connection")).toBe("close");
    expect(calls.slice(0, 4).map((call) => call.init?.method)).toEqual([
      "POST",
      "GET",
      "GET",
      "HEAD",
    ]);
    expect(await status("GET", "/")).toBe(200);
    expect(await status("HEAD", "/app.js")).toBe(200);
    expect(await status("POST", "/")).toBe(405);
    expect(await status("GET", "/undeclared")).toBe(404);
  });

  it("forwards the path it checked, re-encoded", async () => {
    const { value } = endpoint();
    const { calls, fetcher } = upstream(() => new Response("ok"));
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    await proxy(new Request(`${ORIGIN}/_module/a%2Fb%20c?q=%2F`));
    await proxy(new Request(`${ORIGIN}/caf%C3%A9.js`));
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:3000/_module/a/b%20c?q=%2F",
      "http://127.0.0.1:3000/caf%C3%A9.js",
    ]);
    // Never a path the Program could read as another origin.
    for (const path of ["//example.com/a.js", "/%2F%2Fexample.com/a.js"]) {
      expect((await proxy(new Request(`${ORIGIN}${path}`))).status).toBe(404);
    }
    expect(calls).toHaveLength(2);
  });

  it("maps a Program's refusal of a /_module/ call to 502", async () => {
    const { value } = endpoint();
    const { fetcher } = upstream(() => new Response(null, { status: 405 }));
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    const response = await proxy(
      new Request(`${ORIGIN}/_module/theme`, { body: "{}", method: "POST" })
    );
    expect(response.status).toBe(502);
  });

  it("closes short requests but keeps the stream's connection", async () => {
    const { value } = endpoint();
    const { calls, fetcher } = upstream(() => new Response("ok"));
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    await proxy(
      new Request(`${ORIGIN}/_module/graphql`, { body: "{}", method: "POST" })
    );
    await proxy(new Request(`${ORIGIN}/_module/theme`, EVENTS));
    const [graphql, theme] = calls.map(
      (call) => new Headers(call.init?.headers)
    );
    expect(graphql?.get("connection")).toBe("close");
    expect(theme?.has("connection")).toBe(false);
    expect(theme?.get("accept")).toBe("text/event-stream");
  });

  it("passes a stream through until the View disconnects", async () => {
    const { value } = endpoint();
    const events = eventBody();
    const { calls, fetcher } = upstream(
      () =>
        new Response(events.body, {
          headers: { "content-type": "text/event-stream" },
        })
    );
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    const response = await proxy(
      new Request(`${ORIGIN}/_module/theme`, EVENTS)
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self'"
    );
    const reader = response.body?.getReader();
    events.write("data: 1\n\n");
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
      "data: 1\n\n"
    );
    events.write("data: 2\n\n");
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
      "data: 2\n\n"
    );
    await reader?.cancel();
    expect(events.cancelled).toHaveBeenCalled();
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
  });

  it("ends a stream when its Program stops serving", async () => {
    const { serving, value } = endpoint();
    const events = eventBody();
    const { calls, fetcher } = upstream(
      () => new Response(events.body, { status: 200 })
    );
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    const response = await proxy(
      new Request(`${ORIGIN}/_module/theme`, EVENTS)
    );
    const read = response.body?.getReader().read();
    serving.abort();
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    // The View's response ends with the Program, even if upstream stays open.
    await expect(read).rejects.toThrow("stopped serving");
    expect(events.cancelled).toHaveBeenCalled();
  });

  it("times out a stream that never answers, but not one that is open", async () => {
    vi.useFakeTimers();
    const { value } = endpoint();
    const hung = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    );
    const silent = createModuleProxy({ endpoint: () => value }, hung);
    const waiting = silent(new Request(`${ORIGIN}/_module/theme`, EVENTS));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await waiting).status).toBe(502);

    const { calls, fetcher } = upstream(
      () => new Response(eventBody().body, { status: 200 })
    );
    const open = createModuleProxy({ endpoint: () => value }, fetcher);
    const response = await open(new Request(`${ORIGIN}/_module/theme`, EVENTS));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(response.status).toBe(200);
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
  });

  it("maps a refused relay to 502 and releases its upstream", async () => {
    const { value } = endpoint();
    const { calls, fetcher } = upstream(
      () => new Response(null, { status: 403 })
    );
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    expect(
      (await proxy(new Request(`${ORIGIN}/_module/theme`, EVENTS))).status
    ).toBe(502);
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
  });
});

describe("Module proxy request bodies", () => {
  const MIB = 1024 * 1024;

  /** A body the test feeds chunk by chunk, sent without a content-length. */
  function chunked(chunks: Uint8Array[]) {
    const pending = [...chunks];
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        const next = pending.shift();
        if (next) {
          stream.enqueue(next);
        }
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      body,
      duplex: "half",
      method: "POST",
    };
    return init;
  }

  it("forwards a normal POST body", async () => {
    const { value } = endpoint();
    const { calls, fetcher } = upstream(() => new Response("ok"));
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    const response = await proxy(
      new Request(`${ORIGIN}/_module/graphql`, {
        body: '{"query":"{ ok }"}',
        method: "POST",
      })
    );
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(calls[0]?.init?.body as Uint8Array)).toBe(
      '{"query":"{ ok }"}'
    );
  });

  it("refuses a body whose content-length is over the cap without calling the Program", async () => {
    const { value } = endpoint();
    const { fetcher } = upstream(() => new Response("ok"));
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    const response = await proxy(
      new Request(`${ORIGIN}/_module/graphql`, {
        body: "{}",
        headers: { "content-length": String(3 * MIB) },
        method: "POST",
      })
    );
    expect(response.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a chunked body once it grows over the cap", async () => {
    const { value } = endpoint();
    const { fetcher } = upstream(() => new Response("ok"));
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    const response = await proxy(
      new Request(
        `${ORIGIN}/_module/graphql`,
        chunked([new Uint8Array(MIB), new Uint8Array(MIB), new Uint8Array(1)])
      )
    );
    expect(response.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stops reading a body when the View goes away", async () => {
    const { value } = endpoint();
    const { fetcher } = upstream(() => new Response("ok"));
    const proxy = createModuleProxy({ endpoint: () => value }, fetcher);
    const view = new AbortController();
    const reply = proxy(
      new Request(`${ORIGIN}/_module/graphql`, {
        // The first chunk arrives; the rest never does.
        ...chunked([new Uint8Array(8)]),
        signal: view.signal,
      })
    );
    // Abort while the proxy waits for the rest.
    await new Promise((resolve) => setTimeout(resolve, 10));
    view.abort();
    expect((await reply).status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
