import { describe, expect, it } from "vitest";
import { generateId } from "../id";

const HEX_ID = /^[0-9a-f]{32}$/;

describe("generateId", () => {
  it("produces 32-char lowercase hex IDs combining timestamp and crypto entropy", () => {
    const first = generateId();
    const second = generateId();
    expect(first).toMatch(HEX_ID);
    expect(second).toMatch(HEX_ID);
    expect(first).not.toBe(second);
  });

  it("orders IDs lexicographically by timestamp and supports prefixes and injected clocks", () => {
    const zeroBytes = (bytes: Uint8Array) => bytes.fill(0);
    const earlier = generateId({
      now: () => 1_700_000_000_000,
      random: zeroBytes,
    });
    const later = generateId({
      now: () => 1_700_000_000_001,
      random: zeroBytes,
    });
    expect(earlier < later).toBe(true);
    expect(generateId({ now: () => 0, prefix: "msg", random: zeroBytes })).toBe(
      `msg_${"0".repeat(32)}`
    );
    expect(generateId({ now: () => -50, random: zeroBytes })).toBe(
      "0".repeat(32)
    );
  });
});
