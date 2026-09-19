import { describe, expect, it } from "vitest";

import { decodeText, decodeUtf8 } from "../encoding";

describe("UTF-8 decoding", () => {
  it.each(["", "héllo 雪 🌱", "first\nsecond"])("decodes %j", (text) => {
    const bytes = new TextEncoder().encode(text);
    expect(decodeUtf8(bytes)).toBe(text);
    expect(decodeText(bytes)).toBe(text);
  });

  it.each([[0xff], [0xc3], [0xc0, 0x80], [0xed, 0xa0, 0x80]])(
    "rejects malformed UTF-8 %j",
    (...values) => {
      const bytes = new Uint8Array(values);
      expect(decodeUtf8(bytes)).toBeNull();
      expect(decodeText(bytes)).toBeNull();
    }
  );

  it("separates valid NUL characters from text detection", () => {
    const bytes = new Uint8Array([97, 0, 98]);
    expect(decodeUtf8(bytes)).toBe("a\0b");
    expect(decodeText(bytes)).toBeNull();
  });
});
