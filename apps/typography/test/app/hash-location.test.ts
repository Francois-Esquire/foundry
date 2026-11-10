import { describe, expect, it } from "vitest";
import { hashFor, parseHash } from "~/app/hash-location";

describe("parseHash", () => {
  it("reads an empty hash as the empty path", () => {
    expect(parseHash("")).toEqual([]);
    expect(parseHash("#")).toEqual([]);
    expect(parseHash("#/")).toEqual([]);
  });

  it("splits a place and the path below it", () => {
    expect(parseHash("#/library")).toEqual(["library"]);
    expect(parseHash("#/studio/lato-regular/a")).toEqual([
      "studio",
      "lato-regular",
      "a",
    ]);
  });

  it("forgives a missing leading slash and stray slashes", () => {
    expect(parseHash("#studio")).toEqual(["studio"]);
    expect(parseHash("#/studio//a/")).toEqual(["studio", "a"]);
  });

  it("decodes segments and keeps a broken escape as typed", () => {
    expect(parseHash("#/studio/Lato%20Regular/%E0%A4%95")).toEqual([
      "studio",
      "Lato Regular",
      "क",
    ]);
    expect(parseHash("#/studio/100%")).toEqual(["studio", "100%"]);
  });
});

describe("hashFor", () => {
  it("writes the start address for an empty path", () => {
    expect(hashFor()).toBe("#/");
  });

  it("encodes each segment, so a slash inside one survives the round trip", () => {
    const path = ["studio", "Lato Regular", "a/b", "क"];
    expect(hashFor(...path)).toBe("#/studio/Lato%20Regular/a%2Fb/%E0%A4%95");
    expect(parseHash(hashFor(...path))).toEqual(path);
  });
});
