import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TransportHandlers } from "../../live/transport";

import { target, token } from "../helpers/live-double";

const state = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  connects: [] as { app: string; handler: Record<string, unknown> }[],
  opens: [] as {
    extension: { id: string };
    options: Record<string, unknown>;
  }[],
  sent: [] as unknown[],
}));

vi.mock("@fal-ai/client", () => ({
  createFalClient: (config: Record<string, unknown>) => {
    state.configs.push(config);
    return {
      realtime: {
        connect: (app: string, handler: Record<string, unknown>) => {
          state.connects.push({ app, handler });
          return {
            close: () => undefined,
            send: (input: unknown) => state.sent.push(input),
          };
        },
        open: (extension: { id: string }, options: Record<string, unknown>) => {
          state.opens.push({ extension, options });
          const session = {
            close: () => Promise.resolve(),
            ready: Promise.resolve({}),
            send: (input: unknown) => state.sent.push(input),
            session: {},
            state: "live",
          };
          return session;
        },
      },
    };
  },
}));

const { connectFalSocket } = await import("../../live/fal-socket");
const { connectFalWebRtc } = await import("../../live/fal-webrtc");

function handlers(): TransportHandlers & { closes: string[] } {
  const closes: string[] = [];
  return {
    close: (_reason, message) => closes.push(message ?? ""),
    closes,
    data: () => undefined,
    error: () => undefined,
    media: () => undefined,
    message: () => undefined,
  };
}

const OPENING = { direction: { prompt: "p" } };

beforeEach(() => {
  state.connects.length = 0;
  state.opens.length = 0;
  state.configs.length = 0;
  state.sent.length = 0;
});

describe("the socket transport", () => {
  it("presents the token on the client's own tokenProvider option", async () => {
    const access = token();
    await connectFalSocket(target(), access, OPENING, handlers());
    const handler = state.connects[0]?.handler;
    const provider = handler?.tokenProvider as () => Promise<string>;
    await expect(provider()).resolves.toBe(access.token);
  });

  it("arms no token refresh: tokenExpirationSeconds is never supplied", async () => {
    await connectFalSocket(target(), token(), OPENING, handlers());
    // Supplying it alongside a custom tokenProvider is what turns on the
    // client's refresh-at-90% timer, which the Authority rule forbids.
    expect(state.connects[0]?.handler).not.toHaveProperty(
      "tokenExpirationSeconds"
    );
  });

  it("reads no key on the token path, ambient or otherwise", async () => {
    await connectFalSocket(target(), token(), OPENING, handlers());
    // An omitted `credentials` would fall back to the client's own resolver,
    // which reads FAL_KEY from the environment.
    expect(state.configs).toEqual([{ credentials: "" }]);
  });

  it("sends no key on the proxy path either", async () => {
    await connectFalSocket(
      target(),
      { kind: "proxy", url: "https://host/api/fal" },
      OPENING,
      handlers()
    );
    // `when: "always"` is load-bearing: a bare-string proxyUrl normalizes to a
    // `when` of undefined, which `shouldProxy` resolves to `env.isBrowser`, so
    // in Node the middleware installs and then declines to rewrite anything.
    expect(state.configs).toEqual([
      {
        credentials: "",
        proxyUrl: { url: "https://host/api/fal", when: "always" },
      },
    ]);
    expect(state.connects[0]?.handler).not.toHaveProperty("tokenProvider");
  });

  it("refuses credential access when the configured-client holder is empty", async () => {
    await expect(
      connectFalSocket(target(), { kind: "credential" }, OPENING, handlers())
    ).rejects.toThrow(/key-owning process/);
  });

  it("sends a frame on the endpoint's declared image_url field, base64", async () => {
    const transport = await connectFalSocket(
      target(),
      token(),
      OPENING,
      handlers()
    );
    await transport.send({
      correlation: "d1",
      direction: { prompt: "ink" },
      frame: { bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" },
      frameId: "a",
    });
    expect(state.sent).toEqual([
      {
        // "AQID" is base64 for the three bytes supplied above.
        image_url: "data:image/jpeg;base64,AQID",
        prompt: "ink",
        request_id: "d1",
      },
    ]);
  });

  it("encodes a frame of realistic size without overflowing the stack", async () => {
    // A spread of every byte as a call argument overflows V8 at ~200 KB and
    // this runner at ~1 MB, so a 1 MB frame — an ordinary 1080p still —
    // discriminates on both. Buffer is the independent oracle for the value,
    // so a wrong chunk boundary fails here as loudly as an overflow.
    const bytes = new Uint8Array(1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }
    const transport = await connectFalSocket(
      target(),
      token(),
      OPENING,
      handlers()
    );

    await transport.send({
      correlation: "d1",
      direction: { prompt: "ink" },
      frame: { bytes, mime: "image/jpeg" },
    });

    const sent = state.sent[0] as { image_url: string };
    expect(sent.image_url).toBe(
      `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`
    );
  });

  it("decodes a result from the endpoint's declared images[].content", async () => {
    const delivered: unknown[] = [];
    const sink = {
      ...handlers(),
      message: (message: unknown) => delivered.push(message),
    };
    await connectFalSocket(target(), token(), OPENING, sink);
    const onResult = state.connects[0]?.handler.onResult as (
      result: unknown
    ) => void;
    // "Bwg=" is base64 for the two bytes asserted below.
    onResult({
      images: [{ content: "Bwg=", content_type: "image/png" }],
      request_id: "d7",
    });
    expect(delivered).toEqual([
      {
        correlation: "d7",
        media: { bytes: new Uint8Array([7, 8]), mime: "image/png" },
      },
    ]);
  });

  it("reports a vendor socket close as disconnected", async () => {
    const sink = handlers();
    await connectFalSocket(target(), token(), OPENING, sink);
    const onClose = state.connects[0]?.handler.onClose as (event: {
      code: number;
      reason: string;
    }) => void;
    onClose({ code: 1000, reason: "bye" });
    expect(sink.closes).toEqual(["bye"]);
  });

  it("reports an abnormal close, which this client only reports as an error", async () => {
    const sink = handlers();
    await connectFalSocket(target(), token(), OPENING, sink);
    const onError = state.connects[0]?.handler.onError as (error: {
      status: number;
      message: string;
    }) => void;
    onError({ message: "Error closing the connection: gone", status: 1006 });
    expect(sink.closes).toEqual(["Error closing the connection: gone"]);
  });

  it("leaves a message-level error non-terminal", async () => {
    const sink = handlers();
    await connectFalSocket(target(), token(), OPENING, sink);
    const onError = state.connects[0]?.handler.onError as (error: {
      status: number;
      message: string;
    }) => void;
    onError({ message: "NSFW: blocked", status: 400 });
    expect(sink.closes).toEqual([]);
  });
});

describe("the WebRTC transport's extension selection", () => {
  it("selects lucy for an endpoint the lucy extension's own supports() claims", async () => {
    await connectFalWebRtc(
      {
        ...target({ delivery: "continuous" }),
        modelId: "decart/lucy-2-5/realtime",
      },
      token(),
      OPENING,
      handlers()
    );
    expect(state.opens[0]?.extension.id).toMatch(/lucy/i);
  });

  it("selects wma with that endpoint id for a continuous model lucy does not claim", async () => {
    await connectFalWebRtc(
      {
        ...target({ delivery: "continuous" }),
        modelId: "minimax/h3-max/director",
      },
      { kind: "proxy", url: "https://host/api/fal" },
      OPENING,
      handlers()
    );
    expect(state.opens[0]?.extension.id).not.toMatch(/lucy/i);
    expect(state.opens[0]?.options.endpointId).toBe("minimax/h3-max/director");
    // The same proxy gate applies on this path, where the extensions reach the
    // ICE endpoint and the WMA bridge through the client's own request path.
    expect(state.configs).toEqual([
      {
        credentials: "",
        proxyUrl: { url: "https://host/api/fal", when: "always" },
      },
    ]);
  });

  it("refuses a token on the WMA path, which declares no token option", async () => {
    await expect(
      connectFalWebRtc(
        {
          ...target({ delivery: "continuous" }),
          modelId: "minimax/h3-max/director",
        },
        token(),
        OPENING,
        handlers()
      )
    ).rejects.toThrow(/declares no token option/);
  });
});

describe("the WebRTC transport's opening Direction", () => {
  it("does not repeat it on the lucy path, which transmits `input` to open", async () => {
    const transport = await connectFalWebRtc(
      {
        ...target({ delivery: "continuous" }),
        modelId: "decart/lucy-2-5/realtime",
      },
      token(),
      OPENING,
      handlers()
    );
    // `lucy.js:296` sends `options.input` to start the session, so the core's
    // opening send would be a second generation request at open.
    expect(state.opens[0]?.options.input).toEqual({ prompt: "p" });
    await transport.send({ correlation: "d1", direction: { prompt: "p" } });
    expect(state.sent).toEqual([]);

    // Only the opening one is swallowed; a later Direction still goes.
    await transport.send({ correlation: "d2", direction: { prompt: "pan" } });
    expect(state.sent).toEqual([{ prompt: "pan", request_id: "d2" }]);
  });

  it("sends it on the WMA path, which declares no `input`", async () => {
    const transport = await connectFalWebRtc(
      {
        ...target({ delivery: "continuous" }),
        modelId: "minimax/h3-max/director",
      },
      { kind: "proxy", url: "https://host/api/fal" },
      OPENING,
      handlers()
    );
    expect(state.opens[0]?.options).not.toHaveProperty("input");
    await transport.send({ correlation: "d1", direction: { prompt: "p" } });
    expect(state.sent).toEqual([{ prompt: "p", request_id: "d1" }]);
  });
});

describe("the WebRTC transport's feed", () => {
  it("puts the feed in the options the extension is constructed with", async () => {
    const feed = { getTracks: () => [] };
    await connectFalWebRtc(
      {
        ...target({ delivery: "continuous" }),
        modelId: "decart/lucy-2-5/realtime",
      },
      token(),
      { ...OPENING, feed },
      handlers()
    );
    expect(state.opens[0]?.options.localStream).toBe(feed);
    // Nothing was applied to the session afterwards.
    expect(state.sent).toEqual([]);
  });

  it("passes the injected peer-connection factory on the lucy path", async () => {
    const factory = () => ({});
    await connectFalWebRtc(
      {
        ...target({ delivery: "continuous" }),
        modelId: "decart/lucy-2-5/realtime",
      },
      token(),
      { ...OPENING, peerConnectionFactory: factory },
      handlers()
    );
    expect(state.opens[0]?.options.peerConnectionFactory).toBe(factory);
  });
});
