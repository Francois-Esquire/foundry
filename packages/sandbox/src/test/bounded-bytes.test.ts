import { describe, expect, it } from "vitest";

import { BoundedBytes } from "../container/bounded-bytes";

const encoder = new TextEncoder();

describe("BoundedBytes", () => {
  it("keeps everything while under the limit", () => {
    const bytes = new BoundedBytes(16);
    bytes.append(encoder.encode("hello "));
    bytes.append(encoder.encode("world"));
    expect(bytes.text()).toBe("hello world");
  });

  it("keeps the last bytes once output passes the limit", () => {
    const bytes = new BoundedBytes(8);
    for (const part of ["abc", "defg", "hij", "klmno"]) {
      bytes.append(encoder.encode(part));
    }
    expect(bytes.text()).toBe("hijklmno");
  });

  it("keeps the tail of one chunk larger than the limit", () => {
    const bytes = new BoundedBytes(4);
    bytes.append(encoder.encode("ab"));
    bytes.append(encoder.encode("0123456789"));
    bytes.append(encoder.encode("x"));
    expect(bytes.text()).toBe("789x");
  });

  it("is unaffected by the caller reusing its buffer", () => {
    const bytes = new BoundedBytes(8);
    const buffer = encoder.encode("abcd");
    bytes.append(buffer);
    buffer.fill(0x7a);
    expect(bytes.text()).toBe("abcd");
  });

  it("holds the limit across many small chunks", () => {
    const limit = 1000;
    const bytes = new BoundedBytes(limit);
    const one = encoder.encode("a");
    for (let index = 0; index < 200_000; index += 1) {
      bytes.append(one);
    }
    bytes.append(encoder.encode("end"));
    const text = bytes.text();
    expect(text).toHaveLength(limit);
    expect(text.endsWith("aend")).toBe(true);
  });
});
