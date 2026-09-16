import { beforeEach, describe, expect, it, vi } from "vitest";

import { newRegistry, target, token } from "../helpers/live-double";

const state = vi.hoisted(() => ({
  webrtc: { current: null as { connects: number } | null },
}));

vi.mock("../../live/fal-webrtc", async () => {
  const { connector } = await import("../helpers/live-double");
  return {
    connectFalWebRtc: (...args: Parameters<ReturnType<typeof connector>>) => {
      const registry = state.webrtc.current;
      if (registry === null) {
        throw new Error("no webrtc registry installed");
      }
      return connector(registry as never)(...args);
    },
  };
});

const { open } = await import("../../live/node/index");

let webrtc = newRegistry();

beforeEach(() => {
  webrtc = newRegistry();
  state.webrtc.current = webrtc;
});

const CONTINUOUS = { delivery: "continuous", required: ["direction"] } as const;

function track(kind: "video" | "audio", codec?: string) {
  return {
    kind,
    ...(codec === undefined ? {} : { codec: { name: codec } }),
  };
}

describe("the Node interaction", () => {
  it("declares no attach", async () => {
    const live = await open(target({ ...CONTINUOUS }), token(), {
      direction: { prompt: "p" },
    });
    expect((live as { attach?: unknown }).attach).toBeUndefined();
  });

  it("reports one onTrack per received track with the sequence in force", async () => {
    const seen: { kind: string; direction: number }[] = [];
    const live = await open(target({ ...CONTINUOUS }), token(), {
      direction: { prompt: "p" },
      onTrack: (received, direction) =>
        seen.push({ direction, kind: received.kind }),
    });
    const double = webrtc.doubles[0];

    double?.emitMedia({
      getTracks: () => [track("video"), track("audio")],
    });
    live.direct({ prompt: "pan left" });
    double?.emitMedia({ getTracks: () => [track("video")] });

    expect(seen).toEqual([
      { direction: 1, kind: "video" },
      { direction: 1, kind: "audio" },
      { direction: 2, kind: "video" },
    ]);
    expect(live.tracks).toHaveLength(3);
    expect(live.state).toBe("open");
  });

  it("hands the kernel's control-plane strings to onData unparsed", async () => {
    const raw: string[] = [];
    await open(target({ ...CONTINUOUS }), token(), {
      direction: { prompt: "p" },
      onData: (message) => raw.push(message),
    });
    webrtc.doubles[0]?.emitData('{"chunk":1}');
    expect(raw).toEqual(['{"chunk":1}']);
  });

  it("keeps state open and keeps delivering when a track consumer fails", async () => {
    const closes: string[] = [];
    const seen: string[] = [];
    const live = await open(target({ ...CONTINUOUS }), token(), {
      direction: { prompt: "p" },
      onClosed: (reason) => closes.push(reason),
      onTrack: (received) => {
        seen.push(received.kind);
        if (received.kind === "video") {
          throw new Error("forwarding failed");
        }
      },
    });
    expect(() =>
      webrtc.doubles[0]?.emitMedia({
        getTracks: () => [track("video"), track("audio")],
      })
    ).not.toThrow();

    // The failure costs the host that one track, not the rest of the session:
    // the second track is still delivered and still listed.
    expect(seen).toEqual(["video", "audio"]);
    expect(live.tracks).toHaveLength(2);
    expect(live.state).toBe("open");
    expect(closes).toEqual([]);
  });

  it("wraps its single-track feed in the installed MediaStream at negotiation", async () => {
    const feed = track("video");
    const wrapped: unknown[] = [];
    class InstalledStream {
      constructor(readonly tracks: unknown[]) {
        wrapped.push(tracks);
      }
      getTracks() {
        return this.tracks;
      }
    }
    (globalThis as Record<string, unknown>).MediaStream = InstalledStream;
    try {
      await open(
        target({
          delivery: "continuous",
          inputs: ["direction", "feed"],
          required: ["direction", "feed"],
        }),
        token(),
        { direction: { prompt: "p" }, feed: feed as never }
      );
    } finally {
      Reflect.deleteProperty(globalThis, "MediaStream");
    }
    // Both extensions negotiate a stream, and the wrapping belongs to the entry
    // that owns Node media rather than to a transport the browser shares.
    expect(wrapped).toEqual([[feed]]);
    expect(webrtc.doubles[0]?.options.feed).toBeInstanceOf(InstalledStream);
  });
});
