import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type GatewayClient,
  importModuleSdk,
  type ModuleTheme,
} from "./helpers/module-sdk";

const LIGHT: ModuleTheme = { effective: "light", mode: "auto", revision: 1 };
const DARK: ModuleTheme = { effective: "dark", mode: "dark", revision: 2 };

/** A Gateway client whose theme stream the test feeds one value at a time. */
function themeClient() {
  const values: unknown[] = [];
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  let ended = false;
  const observed: { alias: string; signal?: AbortSignal }[] = [];
  const client: GatewayClient = {
    call: () => Promise.reject(new Error("unused")),
    observe(alias, _input, options) {
      observed.push({ alias, signal: options?.signal });
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (values.length === 0 && failure === undefined && !ended) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            if (values.length > 0) {
              yield values.shift();
            } else if (failure) {
              throw failure;
            } else {
              return;
            }
          }
        },
      };
    },
  };
  return {
    client,
    end() {
      ended = true;
      wake?.();
    },
    fail(error: Error) {
      failure = error;
      wake?.();
    },
    observed,
    push(...next: unknown[]) {
      values.push(...next);
      wake?.();
    },
  };
}

async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<unknown> {
  const { done, value } = await reader.read();
  if (done) {
    return "end";
  }
  const text = new TextDecoder().decode(value);
  expect(text.endsWith("\n\n")).toBe(true);
  return JSON.parse(text.slice("data: ".length));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Module theme relay", () => {
  it("answers only GET, and only once the host is connected", async () => {
    const sdk = await importModuleSdk();
    const request = new Request("http://program/_module/theme");
    expect(
      (
        await sdk.relayModuleTheme(
          { client: themeClient().client },
          new Request(request, { method: "POST" })
        )
      ).status
    ).toBe(405);
    expect(
      (await sdk.relayModuleTheme({ client: undefined }, request)).status
    ).toBe(503);
  });

  it.each([
    ["unauthorized", 403],
    ["unknown-alias", 404],
    ["transport-closed", 503],
    ["provider-failure", 502],
  ])("maps a %s first read to %i", async (code, status) => {
    const sdk = await importModuleSdk();
    const host = themeClient();
    host.fail(new sdk.GatewayFailure(code, "Gateway request failed"));
    const response = await sdk.relayModuleTheme(
      host,
      new Request("http://program/_module/theme")
    );
    expect(response.status).toBe(status);
    expect(host.observed[0]?.signal?.aborted).toBe(true);
  });

  it("refuses an invalid first snapshot", async () => {
    const sdk = await importModuleSdk();
    const host = themeClient();
    host.push({ ...LIGHT, secret: "x" });
    const response = await sdk.relayModuleTheme(
      host,
      new Request("http://program/_module/theme")
    );
    expect(response.status).toBe(502);
  });

  it("streams snapshots, coalescing what the View has not read yet", async () => {
    const sdk = await importModuleSdk();
    const host = themeClient();
    host.push(LIGHT);
    const response = await sdk.relayModuleTheme(
      host,
      new Request("http://program/_module/theme")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(host.observed[0]?.alias).toBe("theme");
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Relay has no body");
    }
    expect(await readEvent(reader)).toEqual(LIGHT);
    host.push(
      { ...DARK, revision: 2 },
      { ...DARK, revision: 3 },
      { ...LIGHT, revision: 4 }
    );
    await vi.waitFor(() => expect(host.observed).toHaveLength(1));
    // Let the relay drain the host stream before the View reads.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await readEvent(reader)).toEqual({ ...LIGHT, revision: 4 });
    host.end();
    expect(await readEvent(reader)).toBe("end");
    expect(host.observed[0]?.signal?.aborted).toBe(true);
  });

  it("cancels the Gateway stream when the View disconnects", async () => {
    const sdk = await importModuleSdk();
    const host = themeClient();
    host.push(LIGHT);
    const controller = new AbortController();
    const response = await sdk.relayModuleTheme(
      host,
      new Request("http://program/_module/theme", {
        signal: controller.signal,
      })
    );
    await response.body?.cancel();
    expect(host.observed[0]?.signal?.aborted).toBe(true);
  });
});

/** A fetch whose responses the test scripts, one per call. */
function scriptedFetch(responses: (() => Response)[]) {
  const requests: { signal?: AbortSignal | null; url: string }[] = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    requests.push({ signal: init?.signal, url });
    const next = responses.shift();
    return next
      ? Promise.resolve(next())
      : new Promise<Response>(() => undefined);
  });
  vi.stubGlobal("fetch", fetch);
  return requests;
}

function eventStream(...chunks: string[]) {
  const encoder = new TextEncoder();
  let push: ((chunk: string | null) => void) | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      push = (chunk) => {
        if (chunk === null) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(chunk));
        }
      };
    },
  });
  return {
    get cancelled() {
      return cancelled;
    },
    push: (chunk: string | null) => push?.(chunk),
    response: () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
  };
}

const event = (theme: unknown) => `data: ${JSON.stringify(theme)}\n\n`;

describe("Module theme browser helper", () => {
  it("reports snapshots, drops repeated revisions and clears on disconnect", async () => {
    const sdk = await importModuleSdk();
    const stream = eventStream(event(LIGHT).slice(0, 10));
    const requests = scriptedFetch([stream.response]);
    const seen: (ModuleTheme | null)[] = [];
    const controller = new AbortController();
    const watching = sdk.watchModuleTheme((theme) => seen.push(theme), {
      retryMs: 60_000,
      signal: controller.signal,
    });
    stream.push(event(LIGHT).slice(10));
    await vi.waitFor(() => expect(seen).toEqual([LIGHT]));
    stream.push(event(LIGHT) + event(DARK));
    await vi.waitFor(() => expect(seen).toEqual([LIGHT, DARK]));
    stream.push(null);
    await vi.waitFor(() => expect(seen).toEqual([LIGHT, DARK, null]));
    expect(requests[0]?.url).toBe("/_module/theme");
    controller.abort();
    await watching;
  });

  it("treats a non-success response or an invalid event as unavailable, then reconnects", async () => {
    const sdk = await importModuleSdk();
    const invalid = eventStream(event({ ...LIGHT, mode: "sepia" }));
    const fresh = eventStream(event({ ...DARK, revision: 1 }));
    const requests = scriptedFetch([
      () => new Response(null, { status: 502 }),
      invalid.response,
      fresh.response,
    ]);
    const seen: (ModuleTheme | null)[] = [];
    const controller = new AbortController();
    const watching = sdk.watchModuleTheme((theme) => seen.push(theme), {
      retryMs: 1,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    await vi.waitFor(() =>
      expect(seen).toEqual([null, { ...DARK, revision: 1 }])
    );
    expect(invalid.cancelled).toBe(true);
    controller.abort();
    await watching;
    // Stopping releases the open reader.
    expect(fresh.cancelled).toBe(true);
    expect(requests.at(-1)?.signal?.aborted).toBe(true);
  });
});
