/** Reads and shapes fonts with HarfBuzz. This is the only module that imports it. */
import {
  Direction,
  Feature,
  Blob as HbBlob,
  Buffer as HbBuffer,
  Face as HbFace,
  Font as HbFont,
  type SvgPathCommand,
  shape,
  Variation,
} from "harfbuzzjs";
import { paragraphDirection } from "~/typeface/direction";
import {
  type AxisLocation,
  type FaceDescription,
  locationKey,
  type OutlineFormat,
  type VariationAxis,
} from "~/typeface/face";
import type { Contour, Outline, Segment } from "~/typeface/outline";
import {
  type FontReader,
  type GlyphShape,
  type OpenFace,
  type ShapedRun,
  type ShapeOptions,
  UnreadableFontError,
} from "~/typeface/reading";
import {
  countFaces,
  isCutShort,
  readGlyphCount,
  readHhea,
  readInstances,
  readMacItalic,
  readOs2,
  type TableSource,
} from "./tables";

const NAME = {
  copyright: 0,
  designer: 9,
  family: 1,
  full: 4,
  licence: 13,
  licenceUrl: 14,
  postScript: 6,
  style: 2,
  typographicFamily: 16,
  typographicStyle: 17,
  version: 5,
} as const;

const unique = (values: readonly string[]) => [...new Set(values)].sort();

const toOutline = (commands: readonly SvgPathCommand[]): Outline => {
  const contours: Contour[] = [];
  let start = { x: 0, y: 0 };
  let segments: Segment[] = [];
  let open = false;
  const close = () => {
    if (open) {
      contours.push({ segments, start });
    }
    segments = [];
    open = false;
  };
  for (const { type, values } of commands) {
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = values;
    if (type === "M") {
      close();
      start = { x: a, y: b };
      open = true;
    } else if (type === "L") {
      segments.push({ kind: "line", to: { x: a, y: b } });
    } else if (type === "Q") {
      segments.push({
        control: { x: a, y: b },
        kind: "quadratic",
        to: { x: c, y: d },
      });
    } else if (type === "C") {
      segments.push({
        control1: { x: a, y: b },
        control2: { x: c, y: d },
        kind: "cubic",
        to: { x: e, y: f },
      });
    } else {
      close();
    }
  }
  close();
  return { contours };
};

const outlineFormat = (table: TableSource): OutlineFormat => {
  if (table("glyf")) {
    return "truetype";
  }
  if (table("CFF ")) {
    return "cff";
  }
  return table("CFF2") ? "cff2" : "none";
};

const describe = (face: HbFace, table: TableSource): FaceDescription => {
  const names = face.listNames();
  // English first; a face with no English names still has a name.
  const name = (nameId: number) => {
    const english = face.getName(nameId, "en").trim();
    const other = names.find((entry) => entry.nameId === nameId);
    return (
      english || (other ? face.getName(nameId, other.language).trim() : "")
    );
  };
  const os2 = readOs2(table("OS/2"));
  const hhea = readHhea(table("hhea"));
  const axes: VariationAxis[] = Object.values(face.getAxisInfos())
    .sort((a, b) => a.axisIndex - b.axisIndex)
    .map((axis) => ({
      default: axis.default,
      max: axis.max,
      min: axis.min,
      name: name(axis.nameId) || axis.tag,
      tag: axis.tag,
    }));
  const familyName =
    name(NAME.typographicFamily) || name(NAME.family) || "Unnamed family";
  const styleName =
    name(NAME.typographicStyle) || name(NAME.style) || "Regular";
  return {
    axes,
    characterCount: face.collectUnicodes().length,
    designer: name(NAME.designer) || undefined,
    familyName,
    fullName: name(NAME.full) || `${familyName} ${styleName}`,
    glyphCount: readGlyphCount(table("maxp")),
    // HarfBuzz drops a damaged variation table, and instances mean nothing without axes.
    instances: axes.length > 0 ? readInstances(table("fvar"), name) : [],
    italic: os2?.italic ?? readMacItalic(table("head")),
    layout: {
      positioning: unique(face.getTableFeatureTags("GPOS")),
      scripts: unique([
        ...face.getTableScriptTags("GSUB"),
        ...face.getTableScriptTags("GPOS"),
      ]),
      substitution: unique(face.getTableFeatureTags("GSUB")),
    },
    licence: {
      copyright: name(NAME.copyright) || undefined,
      description: name(NAME.licence) || undefined,
      embedding: os2?.embedding ?? 0,
      url: name(NAME.licenceUrl) || undefined,
    },
    metrics: {
      ascender: os2?.ascender ?? hhea?.ascender ?? face.upem,
      capHeight: os2?.capHeight,
      descender: os2?.descender ?? hhea?.descender ?? 0,
      lineGap: os2?.lineGap ?? hhea?.lineGap ?? 0,
      unitsPerEm: face.upem,
      xHeight: os2?.xHeight,
    },
    outlineFormat: outlineFormat(table),
    postScriptName: name(NAME.postScript),
    styleName,
    version: name(NAME.version) || undefined,
    weightClass: os2?.weightClass ?? 400,
    widthClass: os2?.widthClass ?? 5,
  };
};

class HarfBuzzFace implements OpenFace {
  readonly description: FaceDescription;
  readonly #face: HbFace;
  readonly #font: HbFont;
  readonly #instances = new Map<string, HbFont>();
  #unicodes: Uint32Array | undefined;
  #reverse: Map<number, number[]> | undefined;

  constructor(bytes: Uint8Array, index: number) {
    this.#face = new HbFace(new HbBlob(bytes), index);
    this.#font = new HbFont(this.#face);
    const table: TableSource = (tag) => {
      const data = this.#face.referenceTable(tag)?.slice();
      return data && data.byteLength > 0
        ? new DataView(data.buffer)
        : undefined;
    };
    this.description = describe(this.#face, table);
    if (this.description.glyphCount === 0) {
      throw new UnreadableFontError("This file has no glyphs to read.");
    }
  }

  characters(): Uint32Array {
    this.#unicodes ??= this.#face.collectUnicodes().slice();
    return this.#unicodes;
  }

  glyphForCharacter(codePoint: number): number | undefined {
    return this.#font.nominalGlyph(codePoint) || undefined;
  }

  charactersForGlyph(glyphId: number): readonly number[] {
    if (!this.#reverse) {
      this.#reverse = new Map();
      for (const codePoint of this.characters()) {
        const glyph = this.#font.nominalGlyph(codePoint);
        if (glyph) {
          const list = this.#reverse.get(glyph) ?? [];
          list.push(codePoint);
          this.#reverse.set(glyph, list);
        }
      }
    }
    return this.#reverse.get(glyphId) ?? [];
  }

  glyphName(glyphId: number): string {
    return this.#font.glyphName(glyphId);
  }

  glyph(glyphId: number, location?: AxisLocation): GlyphShape {
    const font = this.#fontAt(location);
    return {
      advance: font.glyphHAdvance(glyphId),
      outline: toOutline(font.glyphToJson(glyphId)),
    };
  }

  shape(text: string, options: ShapeOptions = {}): ShapedRun {
    const direction = options.direction ?? paragraphDirection(text);
    const buffer = new HbBuffer();
    buffer.addText(text);
    buffer.setDirection(direction === "rtl" ? Direction.RTL : Direction.LTR);
    if (options.script) {
      buffer.setScript(options.script);
    }
    if (options.language) {
      buffer.setLanguage(options.language);
    }
    buffer.guessSegmentProperties();
    const features = Object.entries(options.features ?? {}).map(
      ([tag, value]) => new Feature(tag, Number(value))
    );
    shape(this.#fontAt(options.location), buffer, features);
    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();
    return {
      direction,
      glyphs: infos.map((info, index) => ({
        cluster: info.cluster,
        glyphId: info.codepoint,
        xAdvance: positions[index]?.xAdvance ?? 0,
        xOffset: positions[index]?.xOffset ?? 0,
        yAdvance: positions[index]?.yAdvance ?? 0,
        yOffset: positions[index]?.yOffset ?? 0,
      })),
    };
  }

  close(): void {
    this.#instances.clear();
  }

  #fontAt(location: AxisLocation | undefined): HbFont {
    const key = location ? locationKey(location) : "";
    if (!(location && key)) {
      return this.#font;
    }
    let font = this.#instances.get(key);
    if (!font) {
      font = new HbFont(this.#face);
      font.setVariations(
        Object.entries(location).map(
          ([tag, value]) => new Variation(tag, value)
        )
      );
      this.#instances.set(key, font);
    }
    return font;
  }
}

export const harfBuzzReader: FontReader = {
  faceCount(bytes) {
    const count = countFaces(bytes);
    if (count === 0) {
      throw new UnreadableFontError(
        "This file is not a TrueType or OpenType font."
      );
    }
    if (isCutShort(bytes)) {
      throw new UnreadableFontError("This font file is cut short.");
    }
    return count;
  },
  open(bytes, index = 0) {
    if (index >= this.faceCount(bytes)) {
      throw new UnreadableFontError(`This file has no face ${index}.`);
    }
    return new HarfBuzzFace(bytes, index);
  },
};
