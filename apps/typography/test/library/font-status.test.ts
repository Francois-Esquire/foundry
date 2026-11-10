import { describe, expect, it } from "vitest";
import { findRegisteredFont } from "~/library/font-status";

const font = (family: string) => ({ family, loaded: Promise.resolve() });

describe("findRegisteredFont", () => {
  it("finds a family whether or not the browser quotes its name", () => {
    const plain = font("Typography Source abc");
    const quoted = font('"Typography Source def"');
    expect(findRegisteredFont([plain, quoted], "Typography Source abc")).toBe(
      plain
    );
    expect(findRegisteredFont([plain, quoted], "Typography Source def")).toBe(
      quoted
    );
  });

  it("finds nothing for a family that was never registered", () => {
    expect(findRegisteredFont([font("Other")], "Typography Source abc")).toBe(
      undefined
    );
  });
});
