import { describe, expect, it } from "vitest";
import { readStudioPath, studioHash } from "~/studio/studio-address";
import { addedGlyph, sourceGlyph } from "~/typeface/changes";

describe("the Studio's address", () => {
  it("names a face and a glyph", () => {
    expect(studioHash("0123abcd:0", sourceGlyph(45))).toBe(
      "#/studio/0123abcd%3A0/s%3A45"
    );
  });

  it("names the place alone, or a face alone", () => {
    expect(studioHash()).toBe("#/studio");
    expect(studioHash("f:0@wght=700")).toBe("#/studio/f%3A0%40wght%3D700");
  });

  it("reads back what the shell decoded", () => {
    expect(readStudioPath(["f:0@wght=700", "a:run 7/ka"])).toEqual({
      faceId: "f:0@wght=700",
      glyph: addedGlyph("run 7/ka"),
    });
  });

  it("reads an empty or unreadable path as nothing chosen", () => {
    expect(readStudioPath([])).toEqual({});
    expect(readStudioPath(["f:0", "what"])).toEqual({
      faceId: "f:0",
      glyph: undefined,
    });
  });
});
