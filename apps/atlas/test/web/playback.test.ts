import { describe, expect, it } from "vitest";

import { createPlayback } from "../../src/web/playback";

describe("shared playback tracks", () => {
  it("restores independent track clocks after rebuilding the map without catching up wall time", () => {
    const original = createPlayback();
    original.tick(0);
    original.tick(1000);
    original.track("waves", false);
    original.speed(2);
    original.tick(2000);
    const state = original.snapshot();
    const rebuilt = createPlayback();
    rebuilt.restore(state);
    expect(rebuilt.snapshot()).toEqual(state);
    rebuilt.tick(100_000);
    expect(rebuilt.snapshot()).toEqual(state);
    rebuilt.tick(101_000);
    expect(rebuilt.snapshot().time).toBe(5);
    expect(rebuilt.snapshot().tracks.waves.time).toBe(1);
    expect(original.snapshot()).toEqual(state);
  });
  it("advances active tracks and preserves an independently paused track", () => {
    const playback = createPlayback();
    playback.tick(0);
    playback.tick(1000);
    playback.track("current", false);
    playback.tick(2500);
    expect(playback.snapshot().tracks).toEqual({
      current: { playing: false, time: 1 },
      waves: { playing: true, time: 2.5 },
      wind: { playing: true, time: 2.5 },
    });
    playback.track("current", true);
    playback.tick(3000);
    expect(playback.snapshot().tracks.current.time).toBe(1.5);
  });
  it("seeks all tracks, preserves per-track pause and applies global speed", () => {
    const playback = createPlayback();
    playback.track("waves", false);
    playback.seek(20);
    playback.speed(2);
    playback.tick(0);
    playback.tick(1000);
    expect(playback.snapshot().time).toBe(22);
    expect(playback.snapshot().tracks.waves).toEqual({
      playing: false,
      time: 20,
    });
    expect(playback.snapshot().tracks.current.time).toBe(22);
  });
  it("does not catch up paused wall time or advance when every track is paused", () => {
    const playback = createPlayback();
    playback.tick(0);
    playback.tick(1000);
    playback.play(false);
    playback.tick(100_000);
    expect(playback.snapshot().time).toBe(1);
    playback.play(true);
    playback.tick(101_000);
    playback.tick(102_000);
    expect(playback.snapshot().time).toBe(2);
    for (const id of ["current", "wind", "waves"] as const) {
      playback.track(id, false);
    }
    playback.tick(103_000);
    expect(playback.running()).toBe(false);
    expect(playback.snapshot().time).toBe(2);
  });
});
