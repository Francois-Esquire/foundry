import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Sampler } from "../../live/sampler";
import type { LiveResult } from "../../live/types";
import type { InputForm } from "../../types";
import type { Registry } from "../helpers/live-double";

import { frame, newRegistry, target, token } from "../helpers/live-double";

// The mock factories are hoisted above every import, so they reach the
// per-test registries through this holder rather than closing over one.
const state = vi.hoisted(() => ({
  samplerStops: 0,
  samplerThrows: false,
  samples: [] as ((frame: { bytes: Uint8Array; mime: string }) => void)[],
  socket: { current: null as Registry | null },
  webrtc: { current: null as Registry | null },
}));

vi.mock("../../live/fal-socket", async () => {
  const { connector } = await import("../helpers/live-double");
  return {
    connectFalSocket: (...args: Parameters<ReturnType<typeof connector>>) => {
      const registry = state.socket.current;
      if (registry === null) {
        throw new Error("no socket registry installed");
      }
      return connector(registry)(...args);
    },
  };
});

vi.mock("../../live/fal-webrtc", async () => {
  const { connector } = await import("../helpers/live-double");
  return {
    connectFalWebRtc: (...args: Parameters<ReturnType<typeof connector>>) => {
      const registry = state.webrtc.current;
      if (registry === null) {
        throw new Error("no webrtc registry installed");
      }
      return connector(registry)(...args);
    },
  };
});

vi.mock("../../live/sampler", () => ({
  sampleStream: (
    _stream: unknown,
    _intervalMs: number,
    onFrame: (frame: { bytes: Uint8Array; mime: string }) => void
  ): Sampler => {
    if (state.samplerThrows) {
      throw new Error("no media stack");
    }
    state.samples.push(onFrame);
    return {
      stop() {
        state.samplerStops += 1;
      },
    };
  },
}));

const { open } = await import("../../live/index");

let socket = newRegistry();
let webrtc = newRegistry();

beforeEach(() => {
  socket = newRegistry();
  webrtc = newRegistry();
  state.socket.current = socket;
  state.webrtc.current = webrtc;
  state.samples.length = 0;
  state.samplerStops = 0;
  state.samplerThrows = false;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the core's in-flight send settle so the next one can leave. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await Promise.resolve();
  }
}

function collector() {
  const results: LiveResult[] = [];
  const refusals: { input: InputForm; reason: string }[] = [];
  const closes: { reason: string; message?: string }[] = [];
  return {
    closes,
    options: {
      onClosed: (reason: string, message?: string) =>
        closes.push({ reason, ...(message === undefined ? {} : { message }) }),
      onRefused: (input: InputForm, reason: string) =>
        refusals.push({ input, reason }),
      onResult: (result: LiveResult) => results.push(result),
    },
    refusals,
    results,
  };
}

describe("open refusals", () => {
  it("rejects a request-mode fact and opens no transport", async () => {
    await expect(
      open(target({ delivery: "whole", mode: "request" }), token(), {
        direction: { prompt: "p" },
      })
    ).rejects.toThrow(/no live fact/);
    expect(socket.connects).toBe(0);
    expect(webrtc.connects).toBe(0);
  });

  it("rejects a fact declaring another Operation", async () => {
    const declared = target();
    await expect(
      open({ ...declared, operation: "generate-video" }, token(), {
        direction: { prompt: "p" },
      })
    ).rejects.toThrow(/declares operation "generate-image"/);
    expect(socket.connects).toBe(0);
  });

  it("rejects an expired token and opens no transport", async () => {
    await expect(
      open(
        target(),
        { expiresAt: Date.now() - 1, kind: "token", token: "t" },
        { direction: { prompt: "p" } }
      )
    ).rejects.toThrow(/expired/);
    expect(socket.connects).toBe(0);
  });

  it("rejects credential access with no configured client", async () => {
    await expect(
      open(target(), { kind: "credential" }, { direction: { prompt: "p" } })
    ).rejects.toThrow(/key-owning process/);
    expect(socket.connects).toBe(0);
  });

  it("rejects a feed the fact omits, and opens no transport", async () => {
    await expect(
      open(target(), token(), {
        direction: { prompt: "p" },
        feed: {} as unknown as MediaStream,
      })
    ).rejects.toThrow(/does not accept a feed/);
    expect(socket.connects).toBe(0);
    expect(webrtc.connects).toBe(0);
  });

  it("rejects a continuous fact that requires a feed when none is supplied", async () => {
    await expect(
      open(
        target({
          delivery: "continuous",
          inputs: ["direction", "feed"],
          required: ["direction", "feed"],
        }),
        token(),
        { direction: { prompt: "p" } }
      )
    ).rejects.toThrow(/requires a feed at open/);
    expect(webrtc.connects).toBe(0);
  });

  it("leaves nothing open when the opening send is refused", async () => {
    socket.failPrime = true;
    await expect(
      open(target(), token(), { direction: { prompt: "p" } })
    ).rejects.toThrow(/opening send refused/);
    expect(socket.doubles).toHaveLength(1);
    expect(socket.doubles[0]?.closed()).toBe(true);
  });
});

describe("transport authority", () => {
  it("takes the socket for result-per-input and WebRTC for continuous", async () => {
    await open(target(), token(), { direction: { prompt: "p" } });
    expect(socket.connects).toBe(1);
    expect(webrtc.connects).toBe(0);

    await open(
      target({ delivery: "continuous", required: ["direction"] }),
      token(),
      {
        direction: { prompt: "p" },
      }
    );
    expect(webrtc.connects).toBe(1);
    expect(socket.connects).toBe(1);
  });
});

describe("direction attribution on the socket path", () => {
  it("delivers one result carrying direction 1 and the echoed frame id", async () => {
    const sink = collector();
    const live = await open(target(), token(), {
      direction: { prompt: "watercolor" },
      ...sink.options,
    });
    expect(live.direction).toBe(1);

    live.supply(frame(1), "a");
    const double = socket.doubles[0];
    const send = double?.sent.at(-1);
    expect(send?.frameId).toBe("a");
    double?.deliver(send?.correlation);

    expect(sink.results).toEqual([
      {
        direction: 1,
        input: "a",
        media: { bytes: new Uint8Array([9]), mime: "image/jpeg" },
      },
    ]);
  });

  it("reports the earlier sequence on an in-flight result and the new one after", async () => {
    const sink = collector();
    const live = await open(target(), token(), {
      direction: { prompt: "one" },
      ...sink.options,
    });
    const double = socket.doubles[0];

    live.supply(frame(1), "a");
    await settle();
    const first = double?.sent.find(
      (send) => send.frameId === "a"
    )?.correlation;

    expect(live.direct({ prompt: "two" })).toBe(2);
    live.supply(frame(2), "b");
    await settle();
    const second = double?.sent.find(
      (send) => send.frameId === "b"
    )?.correlation;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    // The in-flight answer arrives after the Direction moved on.
    double?.deliver(first);
    double?.deliver(second);

    expect(sink.results.map((result) => result.direction)).toEqual([1, 2]);
    expect(sink.results.map((result) => result.input)).toEqual(["a", "b"]);
  });

  it("delivers a lower sequence arriving after a higher one", async () => {
    const sink = collector();
    const live = await open(target(), token(), {
      direction: { prompt: "one" },
      ...sink.options,
    });
    const double = socket.doubles[0];
    live.supply(frame(1), "a");
    await settle();
    const first = double?.sent.find(
      (send) => send.frameId === "a"
    )?.correlation;
    live.direct({ prompt: "two" });
    live.supply(frame(2), "b");
    await settle();
    const second = double?.sent.find(
      (send) => send.frameId === "b"
    )?.correlation;

    double?.deliver(second);
    double?.deliver(first);

    expect(sink.results.map((result) => result.direction)).toEqual([2, 1]);
  });
});

describe("supersession and throttling", () => {
  it("sends only the last of three frames supplied before acceptance", async () => {
    const live = await open(target(), token(), { direction: { prompt: "p" } });
    const double = socket.doubles[0];
    double?.gate();

    live.supply(frame(1), "a");
    live.supply(frame(2), "b");
    live.supply(frame(3), "c");
    // The first supply is in flight; b and c contend for the single pending slot.
    expect(
      double?.sent.filter((send) => send.frame !== undefined)
    ).toHaveLength(1);

    double?.release();
    await Promise.resolve();
    await Promise.resolve();

    const frames =
      double?.sent.filter((send) => send.frame !== undefined) ?? [];
    expect(frames).toHaveLength(2);
    expect(frames.at(-1)?.frameId).toBe("c");
  });
});

describe("refusal", () => {
  it("refuses a form the fact omits, stays open, and still accepts a supported one", async () => {
    const sink = collector();
    const live = await open(target(), token(), {
      direction: { prompt: "p" },
      ...sink.options,
    });
    const double = socket.doubles[0];

    live.reference([frame(1)]);
    live.attach({} as unknown as MediaStream);
    expect(sink.refusals.map((refusal) => refusal.input)).toEqual([
      "reference-media",
      "feed",
    ]);
    expect(live.state).toBe("open");
    expect(sink.closes).toHaveLength(0);

    live.supply(frame(2), "a");
    expect(double?.sent.at(-1)?.frameId).toBe("a");
  });

  it("refuses attach on a continuous fact, naming open as where a feed belongs", async () => {
    const sink = collector();
    const live = await open(
      target({
        delivery: "continuous",
        inputs: ["direction", "feed"],
        required: ["direction"],
      }),
      token(),
      { direction: { prompt: "p" }, ...sink.options }
    );
    live.attach({} as unknown as MediaStream);
    expect(sink.refusals.map((refusal) => refusal.input)).toEqual(["feed"]);
    expect(sink.refusals[0]?.reason).toMatch(/negotiates its feed at open/);
    expect(sink.refusals[0]?.reason).toMatch(/options\.feed/);
    expect(live.state).toBe("open");
  });

  it("refuses a feed when no media stack can sample it", async () => {
    state.samplerThrows = true;
    const sink = collector();
    const live = await open(
      target({ inputs: ["direction", "frame", "feed"] }),
      token(),
      { direction: { prompt: "p" }, ...sink.options }
    );
    live.attach({} as unknown as MediaStream);
    expect(sink.refusals).toEqual([
      { input: "feed", reason: "no media stack" },
    ]);
    expect(live.state).toBe("open");
  });
});

describe("attach on a supporting socket fact", () => {
  it("sends sampled frames as ordinary inputs, keeping only the latest unsent one", async () => {
    const live = await open(
      target({ inputs: ["direction", "frame", "feed"] }),
      token(),
      { direction: { prompt: "p" } }
    );
    const double = socket.doubles[0];
    live.attach({} as unknown as MediaStream);
    const emit = state.samples[0];
    expect(emit).toBeDefined();

    double?.gate();
    emit?.({ bytes: new Uint8Array([1]), mime: "image/jpeg" });
    emit?.({ bytes: new Uint8Array([2]), mime: "image/jpeg" });
    emit?.({ bytes: new Uint8Array([3]), mime: "image/jpeg" });
    expect(
      double?.sent.filter((send) => send.frame !== undefined)
    ).toHaveLength(1);

    double?.release();
    await Promise.resolve();
    await Promise.resolve();

    const frames =
      double?.sent.filter((send) => send.frame !== undefined) ?? [];
    expect(frames).toHaveLength(2);
    expect(frames.at(-1)?.frame?.bytes).toEqual(new Uint8Array([3]));
  });
});

describe("feed at open on a continuous fact", () => {
  it("hands the feed to the transport as the session is negotiated", async () => {
    const feed = { id: "local" } as unknown as MediaStream;
    await open(
      target({
        delivery: "continuous",
        inputs: ["direction", "feed"],
        required: ["direction", "feed"],
      }),
      token(),
      { direction: { prompt: "p" }, feed }
    );
    // Present in the options the transport was constructed with, not applied
    // to an already-open session.
    expect(webrtc.doubles[0]?.options.feed).toBe(feed);
  });

  it("routes received media to onStream with the sequence in force at receipt", async () => {
    const streams: { stream: unknown; direction: number }[] = [];
    const live = await open(
      target({ delivery: "continuous", required: ["direction"] }),
      token(),
      {
        direction: { prompt: "p" },
        onStream: (stream, direction) => streams.push({ direction, stream }),
      }
    );
    const double = webrtc.doubles[0];
    double?.emitMedia("stream-a");
    live.direct({ prompt: "q" });
    double?.emitMedia("stream-b");

    expect(streams).toEqual([
      { direction: 1, stream: "stream-a" },
      { direction: 2, stream: "stream-b" },
    ]);
  });
});

describe("terminal states", () => {
  it("closes once and drops a late message", async () => {
    const sink = collector();
    const live = await open(target(), token(), {
      direction: { prompt: "p" },
      ...sink.options,
    });
    const double = socket.doubles[0];

    live.close();
    live.close();
    double?.deliver(undefined);

    expect(sink.closes).toEqual([{ reason: "closed" }]);
    expect(sink.results).toHaveLength(0);
    expect(live.state).toBe("closed");
    expect(double?.closed()).toBe(true);
  });

  it("reports a drop as disconnected, refuses later inputs, and never reconnects", async () => {
    const sink = collector();
    const live = await open(target(), token(), {
      direction: { prompt: "p" },
      ...sink.options,
    });
    socket.doubles[0]?.drop("socket gone");

    expect(sink.closes).toEqual([
      { message: "socket gone", reason: "disconnected" },
    ]);
    expect(live.state).toBe("disconnected");

    live.supply(frame(1));
    expect(live.direct({ prompt: "q" })).toBe(1);
    expect(sink.refusals.map((refusal) => refusal.input)).toEqual([
      "frame",
      "direction",
    ]);
    expect(socket.connects).toBe(1);
    expect(sink.closes).toHaveLength(1);
  });

  it("ends as expired when the token's expiry is reached", async () => {
    vi.useFakeTimers();
    const sink = collector();
    const live = await open(
      target(),
      { expiresAt: Date.now() + 5000, kind: "token", token: "t" },
      { direction: { prompt: "p" }, ...sink.options }
    );
    vi.advanceTimersByTime(5000);

    expect(sink.closes).toEqual([{ reason: "expired" }]);
    expect(live.state).toBe("disconnected");
    expect(socket.doubles[0]?.closed()).toBe(true);
  });
});

describe("host isolation and concurrency", () => {
  it("keeps state open when the host's own consumer of the media fails", async () => {
    const sink = collector();
    const live = await open(
      target({ delivery: "continuous", required: ["direction"] }),
      token(),
      {
        direction: { prompt: "p" },
        onStream: () => {
          throw new Error("preview failed");
        },
        ...sink.options,
      }
    );
    expect(() => webrtc.doubles[0]?.emitMedia("s")).toThrow("preview failed");
    expect(live.state).toBe("open");
    expect(sink.closes).toHaveLength(0);
  });

  it("keeps two interactions independent", async () => {
    const first = collector();
    const second = collector();
    const a = await open(target(), token(), {
      direction: { prompt: "a" },
      ...first.options,
    });
    const b = await open(target(), token(), {
      direction: { prompt: "b" },
      ...second.options,
    });

    a.direct({ prompt: "a2" });
    expect(a.direction).toBe(2);
    expect(b.direction).toBe(1);

    a.close();
    expect(b.state).toBe("open");
    expect(second.closes).toHaveLength(0);

    socket.doubles[1]?.deliver(socket.doubles[1].sent.at(-1)?.correlation);
    expect(second.results).toHaveLength(1);
    expect(first.results).toHaveLength(0);
  });
});
