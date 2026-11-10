import { describe, expect, it } from "vitest";
import { scopeFromKey, scopeOptions } from "~/explorer/scopes";

describe("scopeFromKey", () => {
  it("reads a script code or a shared group from the address", () => {
    expect(scopeFromKey("Deva")).toEqual({ code: "Deva", kind: "script" });
    expect(scopeFromKey("shared.punctuation")).toEqual({
      group: "punctuation",
      kind: "shared",
    });
  });

  it("reads nothing from an unknown or absent name", () => {
    expect(scopeFromKey("Klingon")).toBeUndefined();
    expect(scopeFromKey("shared.nothing")).toBeUndefined();
    expect(scopeFromKey(undefined)).toBeUndefined();
  });
});

describe("scopeOptions", () => {
  const options = scopeOptions();

  it("offers the six featured scripts first, then the shared groups, then every other script", () => {
    expect(options.slice(0, 6).map((option) => option.label)).toEqual([
      "Latin",
      "Greek",
      "Cyrillic",
      "Arabic",
      "Hebrew",
      "Devanagari",
    ]);
    expect(options[6]?.value).toBe("shared.digits");
    expect(options.some((option) => option.label === "Thai")).toBe(true);
    expect(options.length).toBeGreaterThan(150);
  });

  it("gives every option a value the address can be read back from", () => {
    expect(new Set(options.map((option) => option.value)).size).toBe(
      options.length
    );
    expect(options.every((option) => scopeFromKey(option.value))).toBe(true);
  });
});
