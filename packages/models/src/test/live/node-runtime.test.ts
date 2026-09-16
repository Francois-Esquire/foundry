import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Werift from "werift";

const WEBRTC_SYMBOLS = [
  "RTCPeerConnection",
  "MediaStream",
  "MediaStreamTrack",
  "RTCIceCandidate",
  "RTCSessionDescription",
] as const;

function clearGlobals(): void {
  for (const name of WEBRTC_SYMBOLS) {
    Reflect.deleteProperty(globalThis, name);
  }
}

afterEach(() => {
  clearGlobals();
  vi.resetModules();
  vi.doUnmock("werift");
});

describe("installWebRtc", () => {
  it("installs the five symbols the vendor client constructs from globals", async () => {
    clearGlobals();
    const { installWebRtc } = await import("../../live/node/runtime");
    installWebRtc();
    for (const name of WEBRTC_SYMBOLS) {
      expect(typeof (globalThis as Record<string, unknown>)[name]).toBe(
        "function"
      );
    }
  });

  it("leaves pre-set globals untouched across two calls, by identity", async () => {
    clearGlobals();
    const preset = Object.fromEntries(
      WEBRTC_SYMBOLS.map((name) => [
        name,
        function Existing(this: unknown) {
          return this;
        },
      ])
    );
    for (const [name, value] of Object.entries(preset)) {
      (globalThis as Record<string, unknown>)[name] = value;
    }

    const { installWebRtc } = await import("../../live/node/runtime");
    installWebRtc();
    installWebRtc();

    for (const [name, value] of Object.entries(preset)) {
      expect((globalThis as Record<string, unknown>)[name]).toBe(value);
    }
  });

  it("is idempotent on its own install: the second call changes nothing", async () => {
    clearGlobals();
    const { installWebRtc } = await import("../../live/node/runtime");
    installWebRtc();
    const installed = Object.fromEntries(
      WEBRTC_SYMBOLS.map((name) => [
        name,
        (globalThis as Record<string, unknown>)[name],
      ])
    );
    installWebRtc();
    for (const [name, value] of Object.entries(installed)) {
      expect((globalThis as Record<string, unknown>)[name]).toBe(value);
    }
  });

  it("throws WEBRTC_UNAVAILABLE naming the symbol the runtime cannot supply", async () => {
    clearGlobals();
    vi.resetModules();
    const werift = await vi.importActual<typeof Werift>("werift");
    vi.doMock("werift", () => ({ ...werift, MediaStreamTrack: undefined }));

    const { installWebRtc } = await import("../../live/node/runtime");
    expect(() => {
      installWebRtc();
    }).toThrow(/MediaStreamTrack/);
  });

  it("rejects `open` when a required symbol cannot be installed", async () => {
    clearGlobals();
    vi.resetModules();
    const werift = await vi.importActual<typeof Werift>("werift");
    vi.doMock("werift", () => ({ ...werift, RTCIceCandidate: undefined }));

    const { open } = await import("../../live/node/index");
    const { target, token } = await import("../helpers/live-double");
    await expect(
      open(
        target({ delivery: "continuous", required: ["direction"] }),
        token(),
        {
          direction: { prompt: "p" },
        }
      )
    ).rejects.toThrow(/RTCIceCandidate/);
  });
});

describe("peerConnection", () => {
  it("returns the same class the runtime installed", async () => {
    clearGlobals();
    const { installWebRtc, peerConnection } = await import(
      "../../live/node/runtime"
    );
    installWebRtc();
    const installed = (globalThis as Record<string, unknown>)
      .RTCPeerConnection as new () => unknown;
    const connection = peerConnection();
    expect(connection).toBeInstanceOf(installed);
    (connection as { close: () => unknown }).close();
  });
});
