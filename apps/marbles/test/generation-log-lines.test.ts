import { describe, expect, it } from "vitest";
import { lines } from "~/process/daemon";
import { MAX_LINE_BYTES } from "~/process/protocol";

function reader(): { readonly seen: string[]; feed(chunk: Buffer): void } {
  const seen: string[] = [];
  return { feed: lines((line) => seen.push(line)), seen };
}

describe("a generation's log lines", () => {
  it("keeps a character whose bytes arrive in two chunks", () => {
    const { feed, seen } = reader();
    const bytes = Buffer.from("café ✓\n");
    feed(bytes.subarray(0, 4));
    feed(bytes.subarray(4, 7));
    feed(bytes.subarray(7));
    expect(seen).toEqual(["café ✓"]);
  });

  it("truncates a line over the limit with a marker and reads on", () => {
    const { feed, seen } = reader();
    feed(Buffer.from("x".repeat(MAX_LINE_BYTES - 1)));
    feed(Buffer.from("éyyyy"));
    feed(Buffer.from("zzzz\nnext\n"));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(
      `${"x".repeat(MAX_LINE_BYTES - 1)} [line truncated at ${String(MAX_LINE_BYTES)} bytes]`
    );
    expect(seen[1]).toBe("next");
  });

  it("passes a line exactly at the limit whole", () => {
    const { feed, seen } = reader();
    const line = "y".repeat(MAX_LINE_BYTES);
    feed(Buffer.from(`${line}\n`));
    expect(seen).toEqual([line]);
  });
});
