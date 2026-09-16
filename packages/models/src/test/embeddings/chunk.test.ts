import { describe, expect, it } from "vitest";

import { chunk } from "../../embeddings/chunk";

describe("chunk — whole strategy", () => {
  it("returns a single non-chunked entry regardless of length", () => {
    const text = "hello world".repeat(1000);
    const result = chunk(text, { kind: "whole" });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ index: 0, isChunked: false, text });
  });

  it("preserves an empty string as a single empty chunk", () => {
    const result = chunk("", { kind: "whole" });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ index: 0, isChunked: false, text: "" });
  });
});

describe("chunk — fixed-cutoff strategy", () => {
  it("returns one non-chunked piece when text fits within maxChars", () => {
    const result = chunk("short", { kind: "fixed-cutoff", maxChars: 10 });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ index: 0, isChunked: false, text: "short" });
  });

  it("splits text exactly at maxChars boundaries when it overflows", () => {
    const result = chunk("0123456789ABCDE", {
      kind: "fixed-cutoff",
      maxChars: 5,
    });

    expect(result).toHaveLength(3);
    expect(result.map((c) => c.text)).toEqual(["01234", "56789", "ABCDE"]);
    expect(result.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(result.every((c) => c.isChunked)).toBe(true);
  });

  it("the last chunk takes whatever remains and is shorter than maxChars", () => {
    const result = chunk("0123456789ABC", {
      kind: "fixed-cutoff",
      maxChars: 5,
    });

    expect(result).toHaveLength(3);
    expect(result.map((c) => c.text)).toEqual(["01234", "56789", "ABC"]);
    expect(result[2]?.text.length).toBe(3);
    expect(result.every((c) => c.isChunked)).toBe(true);
  });

  it("degrades to a single non-chunked entry when text.length === maxChars", () => {
    const result = chunk("hello", { kind: "fixed-cutoff", maxChars: 5 });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ index: 0, isChunked: false, text: "hello" });
  });

  it("rejects non-positive maxChars", () => {
    expect(() => chunk("x", { kind: "fixed-cutoff", maxChars: 0 })).toThrow(
      /maxChars > 0/
    );
    expect(() => chunk("x", { kind: "fixed-cutoff", maxChars: -1 })).toThrow(
      /maxChars > 0/
    );
  });
});
