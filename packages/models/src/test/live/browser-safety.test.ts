/**
 * @vitest-environment happy-dom
 *
 * The in-package browser-environment route: `happy-dom` is already in the
 * workspace catalog, so this proves the browser entry inside the package that
 * owns it and touches no Studio file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

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

/**
 * Captured at module scope, BEFORE the first `import()` below evaluates the
 * entry. Sampling inside the test would read the globals after another test in
 * this file had already imported and cached the module, which makes the
 * comparison compare the post-import state with itself.
 */
const BEFORE_IMPORT = WEBRTC_SYMBOLS.map(
  (name) => (globalThis as Record<string, unknown>)[name]
);

const LIVE_DIR = join(import.meta.dirname, "..", "..", "live");

function browserSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node" ? [] : browserSources(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("@foundry/models/live in a browser-like environment", () => {
  it("imports with no werift module in its graph", async () => {
    // The mock factories above throw on evaluation, so this import only
    // succeeds while nothing under the browser entry reaches werift.
    const entry = await import("../../live/index");
    expect(typeof entry.open).toBe("function");
  });

  it("installs no WebRTC global", async () => {
    await import("../../live/index");
    expect(
      WEBRTC_SYMBOLS.map(
        (name) => (globalThis as Record<string, unknown>)[name]
      )
    ).toEqual(BEFORE_IMPORT);
  });

  it("names no Node module or WebRTC library outside src/live/node", () => {
    const offenders = browserSources(LIVE_DIR).filter((path) =>
      /from "(node:[^"]*|werift[^"]*)"/.test(readFileSync(path, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
