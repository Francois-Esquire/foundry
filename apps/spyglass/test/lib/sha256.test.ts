import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/sha256";
import { hash16 } from "../../src/lib/short-hash";

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const ONE_MIB = 1_048_576;

const native = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

describe("sha256Hex", () => {
  it("matches the published test vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it.each([
    ["empty", ""],
    ["ASCII", '{"operation":"fold-package","source":"packages/a"}'],
    ["Latin-1", "café naïve Ångström"],
    ["CJK", "漢字のパッケージ"],
    ["an astral character (surrogate pair)", "🦊 packages/émoji-🦊"],
    ["a lone high surrogate", "a\ud800b"],
    ["a lone low surrogate", "a\udc00b"],
    ["NUL and control characters", "\u0000\u0001\n\t"],
    ["a 1 MiB string", "x".repeat(ONE_MIB)],
    [
      "JSON of non-ASCII facts",
      JSON.stringify({
        files: ["src/ünïcode.ts", "src/日本.ts"],
        lone: "\ud800",
      }),
    ],
  ])("equals node:crypto for %s", (_label, text) => {
    expect(sha256Hex(text)).toBe(native(text));
  });

  it("returns 64 lowercase hexadecimal digits, most significant byte first", () => {
    const digest = sha256Hex("abc");
    expect(digest).toMatch(HEX_DIGEST);
    expect(digest.slice(0, 2)).toBe("ba");
  });
});

describe("hash16", () => {
  it.each([
    ["a rule list", [{ id: "rule:a", kind: "forbid" }]],
    ["non-ASCII facts", { file: "src/日本.ts", lone: "\ud800", name: "café" }],
    ["a string", "plan:fold-package"],
    ["null", null],
  ])("equals the first 16 digits of node:crypto for %s", (_label, value) => {
    expect(hash16(value)).toBe(native(JSON.stringify(value)).slice(0, 16));
  });
});
