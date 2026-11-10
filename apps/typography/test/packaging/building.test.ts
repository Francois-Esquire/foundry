/**
 * The font engine through its port, in Node: what it builds reloads in
 * HarfBuzz with the coverage, shaping and names that were asked for.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { BuildError, type FontBuilder } from "~/packaging/building";
import { isWoff2, unpackWoff2 } from "~/packaging/container";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { translateOutline } from "~/typeface/outline";
import { UnreadableFontError } from "~/typeface/reading";
import { fontBytes, TRIANGLE } from "../helpers/fixtures";
import { withDamagedTable } from "./helpers/damage";
import {
  charactersOf,
  firstAdvanceOf,
  glyphCountOf,
  glyphOf,
  requestFor,
} from "./helpers/requests";

const CONJUNCT = "क्ष";
const CONVERSION_NOTE = "Converted PostScript outlines to TrueType outlines.";

describe("building derived fonts", () => {
  const lato = fontBytes("lato");
  const sofia = fontBytes("sofia");
  const devanagari = fontBytes("devanagari");
  const latoFace = harfBuzzReader.open(lato);
  const sofiaFace = harfBuzzReader.open(sofia);
  let builder: FontBuilder;

  const build = async (...parameters: Parameters<typeof requestFor>) => {
    const built = await builder.build(requestFor(...parameters));
    return { built, face: harfBuzzReader.open(built.bytes) };
  };

  beforeAll(async () => {
    builder = await nodeFontBuilder();
  });

  describe("static and pinned sources", () => {
    it("builds a static font with an edit and a new family name", async () => {
      const a = glyphOf(latoFace, "a");
      const { built, face } = await build(lato, {
        familyName: "Atlas Sans",
        overrides: new Map([[a, { advance: 1234 }]]),
      });
      expect(face.description.familyName).toBe("Atlas Sans");
      expect(face.description.fullName).toBe("Atlas Sans Regular");
      expect(face.description.postScriptName).toBe("AtlasSans-Regular");
      expect(face.description.axes).toEqual([]);
      expect(built.glyphCount).toBe(latoFace.description.glyphCount);
      expect(face.glyph(glyphOf(face, "a")).advance).toBe(1234);
      expect(face.glyph(glyphOf(face, "b"))).toEqual(
        latoFace.glyph(glyphOf(latoFace, "b"))
      );
    });

    it("pins a variable source to one instance and names it", async () => {
      const location = { wght: 700 };
      const { built, face } = await build(sofia, {
        familyName: "Sofia Pinned",
        location,
        styleName: "Bold",
      });
      const h = glyphOf(sofiaFace, "H");
      expect(sofiaFace.glyph(h, location).advance).not.toBe(
        sofiaFace.glyph(h).advance
      );
      expect(face.description.axes).toEqual([]);
      expect(face.glyph(glyphOf(face, "H")).advance).toBe(
        sofiaFace.glyph(h, location).advance
      );
      expect(face.description.styleName).toBe("Bold");
      expect(face.description.fullName).toBe("Sofia Pinned Bold");
      expect(face.description.weightClass).toBe(700);
      expect(built.notes).toContain(
        "Pinned the variable font to one instance."
      );
    });

    it("links an italic of another weight to its upright", async () => {
      const { face } = await build(lato, {
        familyName: "Atlas Sans",
        styleName: "Light Italic",
      });
      expect(face.description.familyName).toBe("Atlas Sans");
      expect(face.description.styleName).toBe("Light Italic");
      expect(face.description.fullName).toBe("Atlas Sans Light Italic");
      expect(face.description.postScriptName).toBe("AtlasSans-LightItalic");
    });

    it("keeps a style outside the four linked ones in a family of its own", async () => {
      const { face } = await build(sofia, {
        familyName: "Sofia Pinned",
        location: { wght: 900 },
        styleName: "Black",
      });
      expect(face.description.familyName).toBe("Sofia Pinned");
      expect(face.description.styleName).toBe("Black");
      expect(face.description.postScriptName).toBe("SofiaPinned-Black");
    });
  });

  describe("subsets", () => {
    it("keeps a Devanagari conjunct that no character maps to", async () => {
      const { face } = await build(devanagari, {
        location: { wght: 400 },
        subset: { characters: charactersOf(CONJUNCT) },
      });
      expect(face.description.characterCount).toBe(3);
      expect(face.description.glyphCount).toBeGreaterThan(4);
      expect(face.shape(CONJUNCT).glyphs).toHaveLength(1);
      expect(
        face.charactersForGlyph(face.shape(CONJUNCT).glyphs[0]?.glyphId ?? 0)
      ).toEqual([]);
      expect(face.glyphForCharacter(0x09_16)).toBeUndefined();
    });

    it("keeps Latin ligatures of the characters it keeps", async () => {
      const { built, face } = await build(lato, {
        subset: { characters: charactersOf("fil") },
      });
      expect(built.characterCount).toBe(3);
      expect(glyphCountOf(face, "fi")).toBe(1);
      expect(glyphCountOf(face, "fl")).toBe(1);
      expect(face.glyphForCharacter(0x61)).toBeUndefined();
      expect(built.bytes.byteLength).toBeLessThan(lato.byteLength / 20);
    });

    it("subsets an unchanged variable source and leaves it variable", async () => {
      const { face } = await build(devanagari, {
        subset: { characters: charactersOf(CONJUNCT) },
      });
      expect(face.description.axes.map((axis) => axis.tag)).toEqual([
        "wght",
        "wdth",
      ]);
      const [regular] = face.shape(CONJUNCT).glyphs;
      const [black] = face.shape(CONJUNCT, { location: { wght: 900 } }).glyphs;
      expect(face.shape(CONJUNCT).glyphs).toHaveLength(1);
      expect(black?.xAdvance).toBeGreaterThan(regular?.xAdvance ?? 0);
    });

    // The engine saves and reopens an instanced font before it subsets it.
    // With these fixtures and fontTools 4.62.1 the subsetter also works without
    // that step, so this guards the pinned-then-subset path, not a known crash.
    it("subsets a font it has just instanced", async () => {
      const { face } = await build(sofia, {
        location: { wght: 300 },
        styleName: "Light",
        subset: { characters: charactersOf("Typo") },
      });
      expect(face.description.axes).toEqual([]);
      expect(face.description.characterCount).toBe(4);
      expect(face.glyph(glyphOf(face, "T")).advance).toBe(
        sofiaFace.glyph(glyphOf(sofiaFace, "T"), { wght: 300 }).advance
      );
    });
  });

  describe("choosing features", () => {
    const characters = charactersOf("fiAV");
    const plainAdvance = latoFace.glyph(glyphOf(latoFace, "A")).advance;

    it("keeps every feature the glyphs need when none is named", async () => {
      const { face } = await build(lato, { subset: { characters } });
      expect(glyphCountOf(face, "fi")).toBe(1);
      expect(firstAdvanceOf(face, "AV")).toBeLessThan(plainAdvance);
    });

    it("keeps kerning without ligatures", async () => {
      const { face } = await build(lato, {
        subset: { characters, features: ["kern"] },
      });
      expect(glyphCountOf(face, "fi")).toBe(2);
      expect(firstAdvanceOf(face, "AV")).toBeLessThan(plainAdvance);
      expect(face.description.layout.substitution).toEqual([]);
    });

    it("keeps ligatures without kerning", async () => {
      const { face } = await build(lato, {
        subset: { characters, features: ["liga"] },
      });
      expect(glyphCountOf(face, "fi")).toBe(1);
      expect(firstAdvanceOf(face, "AV")).toBe(plainAdvance);
      expect(face.description.layout.substitution).toEqual(["liga"]);
    });

    it("removes every feature for an empty set", async () => {
      const { face } = await build(lato, {
        subset: { characters, features: [] },
      });
      expect(glyphCountOf(face, "fi")).toBe(2);
      expect(firstAdvanceOf(face, "AV")).toBe(plainAdvance);
      expect(face.description.layout.substitution).toEqual([]);
      expect(face.description.layout.positioning).toEqual([]);
    });

    it("chooses features and keeps every character", async () => {
      const { face } = await build(lato, { subset: { features: ["liga"] } });
      expect(face.description.characterCount).toBe(
        latoFace.description.characterCount
      );
      expect(glyphCountOf(face, "fi")).toBe(1);
      expect(firstAdvanceOf(face, "AV")).toBe(plainAdvance);
    });
  });

  describe("WOFF2", () => {
    // HarfBuzz reads plain font files only, so a WOFF2 file is proved in two
    // steps here: the engine unpacks it (fontTools and Brotli), and HarfBuzz
    // then has to read the same glyphs and shaping as the uncompressed build.
    // The integration suite adds two readers that share no code with the
    // engine: Chrome's FontFace and the OpenType Sanitizer.
    it("writes a WOFF2 file that unpacks to the same font", async () => {
      const subset = { characters: charactersOf("office") };
      const plain = await build(lato, { subset });
      const packed = await builder.build(
        requestFor(lato, { flavor: "woff2", subset })
      );
      expect(isWoff2(packed.bytes)).toBe(true);
      expect(isWoff2(plain.built.bytes)).toBe(false);
      expect(packed.bytes.byteLength).toBeLessThan(
        plain.built.bytes.byteLength
      );
      expect(() => harfBuzzReader.open(packed.bytes)).toThrow(
        UnreadableFontError
      );

      const unpacked = harfBuzzReader.open(
        await unpackWoff2(builder, packed.bytes)
      );
      expect(unpacked.description.characterCount).toBe(5);
      expect(unpacked.description.glyphCount).toBe(
        plain.face.description.glyphCount
      );
      expect(unpacked.shape("office").glyphs).toEqual(
        plain.face.shape("office").glyphs
      );
      expect(unpacked.glyph(glyphOf(unpacked, "f"))).toEqual(
        plain.face.glyph(glyphOf(plain.face, "f"))
      );
    });
  });

  describe("PostScript outlines", () => {
    const postscript = fontBytes("postscript");
    const postscriptFace = harfBuzzReader.open(postscript);

    it("converts to TrueType outlines when a glyph is redrawn, and says so", async () => {
      const a = glyphOf(postscriptFace, "a");
      const before = postscriptFace.glyph(a);
      const { built, face } = await build(postscript, {
        overrides: new Map([[a, { outline: TRIANGLE }]]),
      });
      expect(postscriptFace.description.outlineFormat).toBe("cff");
      expect(face.description.outlineFormat).toBe("truetype");
      expect(built.notes).toContain(CONVERSION_NOTE);
      expect(face.glyph(glyphOf(face, "a")).outline.contours).toHaveLength(1);
      expect(face.glyph(glyphOf(face, "a")).advance).toBe(before.advance);
      const b = face.glyph(glyphOf(face, "b"));
      const sourceB = postscriptFace.glyph(glyphOf(postscriptFace, "b"));
      expect(b.advance).toBe(sourceB.advance);
      expect(b.outline.contours).toHaveLength(sourceB.outline.contours.length);
      expect((await builder.validate(built.bytes)).issues).toEqual([]);
    });

    it("keeps PostScript outlines when no glyph is redrawn", async () => {
      const { built, face } = await build(postscript, {
        familyName: "Mono Derived",
        subset: { characters: charactersOf("code") },
      });
      expect(face.description.outlineFormat).toBe("cff");
      expect(built.notes).not.toContain(CONVERSION_NOTE);
    });
  });

  describe("feature code", () => {
    it("grafts feature code twice and keeps the source's own rules", async () => {
      const { glyphNames } = await builder.describeLayout(lato);
      const name = (character: string) =>
        glyphNames[glyphOf(latoFace, character)];
      const header = "languagesystem DFLT dflt; languagesystem latn dflt;";
      const { face } = await build(lato, {
        added: [
          {
            advance: 1000,
            characters: [0xe0_00],
            key: "triangle",
            name: "triangle",
            outline: TRIANGLE,
            provenance: { origin: "manual" },
          },
        ],
        featureCode: [
          `${header} feature liga { sub ${name("a")} ${name("b")} by triangle; } liga;`,
          `${header} feature liga { sub ${name("c")} ${name("d")} by triangle; } liga;`,
          `${header} feature ss20 { sub ${name("x")} by triangle; } ss20;`,
        ],
      });
      const triangle = glyphOf(face, "\u{e000}");
      const glyphs = (text: string, features?: Record<string, boolean>) =>
        face.shape(text, { features }).glyphs.map((glyph) => glyph.glyphId);
      expect(glyphs("ab")).toEqual([triangle]);
      expect(glyphs("cd")).toEqual([triangle]);
      expect(glyphs("x")).toEqual([glyphOf(face, "x")]);
      expect(glyphs("x", { ss20: true })).toEqual([triangle]);
      expect(glyphCountOf(face, "fi")).toBe(1);
      expect(glyphCountOf(latoFace, "ab")).toBe(2);
      expect(firstAdvanceOf(face, "AV")).toBe(firstAdvanceOf(latoFace, "AV"));
      expect(face.description.layout.substitution).toEqual(
        [...latoFace.description.layout.substitution, "ss20"].sort()
      );
    });
  });

  describe("failures", () => {
    const failure = (request: ReturnType<typeof requestFor>) =>
      builder.build(request).then(
        () => {
          throw new Error("The build should have failed.");
        },
        (error: unknown) => error as Error
      );

    it("raises a BuildError for a file that is not a font", async () => {
      const error = await failure(requestFor(new Uint8Array([1, 2, 3, 4])));
      expect(error).toBeInstanceOf(BuildError);
      expect(error.message).toBe(
        "The source file does not open as a font: Not a TrueType or OpenType font (not enough data)"
      );
    });

    it("says how to change a variable source", async () => {
      const error = await failure(
        requestFor(sofia, {
          overrides: new Map([[glyphOf(sofiaFace, "a"), { advance: 500 }]]),
        })
      );
      expect(error).toBeInstanceOf(BuildError);
      expect(error.message).toBe(
        "Pin an instance of this variable font before changing its glyphs."
      );
    });

    it("reports feature code that does not compile on one line", async () => {
      const error = await failure(
        requestFor(lato, {
          featureCode: [
            "feature liga { sub nonexistent by alsomissing; } liga;",
          ],
        })
      );
      expect(error).toBeInstanceOf(BuildError);
      expect(error.message).toContain("nonexistent");
      expect(error.message).not.toContain("\n");
      expect(error.message).not.toContain("Traceback");
    });

    it("names a glyph id the source does not have", async () => {
      const error = await failure(
        requestFor(lato, { overrides: new Map([[99_999, { advance: 10 }]]) })
      );
      expect(error.message).toBe("The source font has no glyph 99999.");
    });
  });

  describe("engine validation", () => {
    it("accepts the fixtures as they are", async () => {
      const fixtures = [
        "lato",
        "sofia",
        "devanagari",
        "postscript",
        "arabic",
        "hebrew",
      ] as const;
      for (const font of fixtures.map(fontBytes)) {
        const report = await builder.validate(font);
        expect(report.issues).toEqual([]);
        expect(report.loadable).toBe(true);
      }
    });

    it("catches one damaged table in an otherwise sound font", async () => {
      const report = await builder.validate(withDamagedTable(lato, "GSUB"));
      expect(report.loadable).toBe(false);
      expect(report.issues).toHaveLength(1);
      expect(report.issues[0]?.table).toBe("GSUB");
      expect(report.issues[0]?.message).toContain(
        "The GSUB table is damaged and cannot be read"
      );
    });

    it("catches a font whose outlines are damaged", async () => {
      const edited = translateOutline(TRIANGLE, 10, 0);
      const { built } = await build(lato, {
        overrides: new Map([[glyphOf(latoFace, "a"), { outline: edited }]]),
        subset: { characters: charactersOf("ab") },
      });
      expect((await builder.validate(built.bytes)).loadable).toBe(true);
      const report = await builder.validate(
        withDamagedTable(built.bytes, "glyf")
      );
      expect(report.loadable).toBe(false);
      expect(report.issues.map((issue) => issue.table)).toContain("glyf");
    });
  });
});
