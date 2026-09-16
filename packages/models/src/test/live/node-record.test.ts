import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { newRegistry, target, token } from "../helpers/live-double";

const state = vi.hoisted(() => ({
  recorders: [] as { path: string; tracks: unknown[]; stopped: boolean }[],
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

/**
 * The recorder double stands in for werift's `MediaRecorder`. It writes no
 * file, which is what lets the refusal cases assert that none was created.
 */
vi.mock("werift/nonstandard", () => ({
  MediaRecorder: class {
    readonly stopped = false;
    constructor(props: { path: string; tracks: unknown[] }) {
      state.recorders.push({ ...props, stopped: false });
    }
    stop(): Promise<void> {
      const record = state.recorders.at(-1);
      if (record !== undefined) {
        record.stopped = true;
      }
      return Promise.resolve();
    }
  },
}));

const { open } = await import("../../live/node/index");

let webrtc = newRegistry();

beforeEach(() => {
  webrtc = newRegistry();
  state.webrtc.current = webrtc;
  state.recorders.length = 0;
});

const CONTINUOUS = { delivery: "continuous", required: ["direction"] } as const;

function track(kind: "video" | "audio", codec = "VP8") {
  return { codec: { name: codec }, kind };
}

function destination(name: string): string {
  return join(tmpdir(), `foundry-live-${name}-${String(Date.now())}.webm`);
}

async function session(codec = "VP8") {
  const live = await open(target({ ...CONTINUOUS }), token(), {
    direction: { prompt: "a harbour" },
  });
  webrtc.doubles[0]?.emitMedia({ getTracks: () => [track("video", codec)] });
  return live;
}

describe("record", () => {
  it("bounds the segment by the directions in force at start and stop", async () => {
    const live = await session();
    const path = destination("bounded");
    const recording = live.record(path);
    expect(live.direct({ prompt: "now pan left" })).toBe(2);

    const segment = await recording.stop();
    expect(segment).toMatchObject({
      endedDirection: 2,
      mime: "video/webm",
      path,
      startedDirection: 1,
    });
    expect(segment.durationMs).toBeGreaterThanOrEqual(0);
    expect(state.recorders.at(-1)?.stopped).toBe(true);
  });

  it("mutes nothing and decodes nothing: the recorder receives the received tracks", async () => {
    const live = await session();
    live.record(destination("tracks"));
    expect(state.recorders).toHaveLength(1);
    expect(state.recorders[0]?.tracks).toEqual(live.tracks);
  });

  it("refuses when no track has been received, and creates no file", async () => {
    const live = await open(target({ ...CONTINUOUS }), token(), {
      direction: { prompt: "p" },
    });
    const path = destination("no-track");
    expect(() => live.record(path)).toThrow(/no track has been received/);
    expect(state.recorders).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
    expect(live.state).toBe("open");
  });

  it("refuses a second concurrent recording, and creates no second file", async () => {
    const live = await session();
    live.record(destination("first"));
    const second = destination("second");
    expect(() => live.record(second)).toThrow(/already active/);
    expect(state.recorders).toHaveLength(1);
    expect(existsSync(second)).toBe(false);
    expect(live.state).toBe("open");
  });

  it("releases the slot on stop, so a second segment can be recorded", async () => {
    const live = await session();
    await live.record(destination("first")).stop();
    live.direct({ prompt: "second take" });

    const second = live.record(destination("second"));
    expect(state.recorders).toHaveLength(2);
    await expect(second.stop()).resolves.toMatchObject({
      endedDirection: 2,
      startedDirection: 2,
    });
  });

  it("refuses a codec the webm writer does not carry rather than transcoding", async () => {
    const live = await session("PCMU");
    const path = destination("uncarried");
    expect(() => live.record(path)).toThrow(/does not carry the negotiated/);
    expect(state.recorders).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
  });

  it("stops an active recording on close and still yields its segment", async () => {
    const live = await session();
    const recording = live.record(destination("closed"));
    live.close();
    expect(state.recorders.at(-1)?.stopped).toBe(true);
    await expect(recording.stop()).resolves.toMatchObject({
      endedDirection: 1,
      startedDirection: 1,
    });
  });
});
