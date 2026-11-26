import { describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  decodeText,
  decodeUtf8,
} from "../encoding";

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

describe("portable base64", () => {
  it("round-trips binary bytes without Buffer", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("encodes values larger than an argument-spread call can hold", () => {
    const bytes = new Uint8Array(1024 * 1024 + 7);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }
    const decoded = base64ToBytes(bytesToBase64(bytes));
    expect(decoded).toHaveLength(bytes.length);
    expect(decoded.every((byte, index) => byte === bytes[index])).toBe(true);
  });
});
