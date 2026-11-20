import type { ChannelMessage } from "@foundry/workflows/channels";
import { describe, expect, it } from "vitest";
import {
  appendStream,
  STREAM_TAIL_LINES,
  streamDelta,
  streamTail,
} from "~/cli/state/run-stream";

function text(path: readonly string[], value: string): ChannelMessage {
  return {
    _tag: "chunk",
    chunk: {
      at: "2026-09-22T14:30:00.000Z",
      path,
      payload: { kind: "text", text: value },
      stepId: path.join("."),
    },
  };
}

describe("streamDelta", () => {
  it("takes text from the selected step and the steps under it", () => {
    expect(streamDelta(text(["write"], "a"), "write")).toBe("a");
    expect(streamDelta(text(["write", "draft"], "b"), "write")).toBe("b");
    expect(streamDelta(text(["writer"], "c"), "write")).toBeUndefined();
    expect(streamDelta(text(["find"], "d"))).toBe("d");
  });

  it("ignores data chunks", () => {
    const data: ChannelMessage = {
      _tag: "chunk",
      chunk: {
        at: "2026-09-22T14:30:00.000Z",
        path: ["write"],
        payload: { data: 1, kind: "data" },
        stepId: "write",
      },
    };
    expect(streamDelta(data)).toBeUndefined();
  });
});

describe("appendStream", () => {
  it("keeps the most recent twenty thousand characters", () => {
    const appended = appendStream("x".repeat(20_000), "yz");
    expect(appended).toHaveLength(20_000);
    expect(appended.endsWith("yz")).toBe(true);
  });
});

describe("streamTail", () => {
  it("shows the last lines, and one blank line before any output", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    expect(streamTail(lines.join("\n"))).toEqual(
      lines.slice(-STREAM_TAIL_LINES)
    );
    expect(streamTail("")).toEqual([""]);
  });
});
