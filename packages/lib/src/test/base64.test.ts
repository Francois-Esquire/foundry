import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "../encoding";

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
