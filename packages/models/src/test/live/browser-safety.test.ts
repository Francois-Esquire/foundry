// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const FROM_NODE_WERIFT_PATTERN = /from "(node:[^"]*|werift[^"]*)"/;

vi.mock("werift", () => {
  throw new Error("the browser live entry must not import werift");
});
vi.mock("werift/nonstandard", () => {
  throw new Error("the browser live entry must not import werift/nonstandard");
});

const WEBRTC_SYMBOLS = [
  "RTCPeerConnection",
  "MediaStream",
  "MediaStreamTrack",
  "RTCIceCandidate",
  "RTCSessionDescription",
] as const;

const BEFORE_IMPORT = WEBRTC_SYMBOLS.map(
  (name) => (globalThis as Record<string, unknown>)[name]
);

const SRC_DIR = join(import.meta.dirname, "..", "..");
const LIVE_DIR = join(SRC_DIR, "live");
const LIVE_ENTRY = join(SRC_DIR, "live.ts");

function browserSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return browserSources(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("@foundry/models/live in a browser-like environment", () => {
  it("imports with no werift module in its graph", async () => {
    const entry = await import("../../live");
    expect(typeof entry.open).toBe("function");
  });

  it("installs no WebRTC global", async () => {
    await import("../../live");
    expect(
      WEBRTC_SYMBOLS.map(
        (name) => (globalThis as Record<string, unknown>)[name]
      )
    ).toEqual(BEFORE_IMPORT);
  });

  it("names no Node module or WebRTC library in the browser live graph", () => {
    const offenders = [LIVE_ENTRY, ...browserSources(LIVE_DIR)].filter((path) =>
      FROM_NODE_WERIFT_PATTERN.test(readFileSync(path, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
