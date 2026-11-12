/** Finding a glyph in a face: by character, by name, by code point or by glyph id. */
import type { GlyphRef } from "~/typeface/changes";
import type { GlyphEntry } from "~/typeface/glyphs";
import { parseCodePoint } from "~/unicode/code-point";

const SOURCE_ADDRESS = /^s:(\d+)$/;
const ADDED_ADDRESS = /^a:(.+)$/s;
const GLYPH_ID = /^(?:#|gid\s*)(\d+)$/i;
const EXPLICIT_CODE_POINT = /^(?:u\+|0x)/i;

export const parseGlyphAddress = (text: string): GlyphRef | undefined => {
  const source = SOURCE_ADDRESS.exec(text)?.[1];
  if (source !== undefined) {
    return { glyphId: Number(source), kind: "source" };
  }
  const key = ADDED_ADDRESS.exec(text)?.[1];
  return key === undefined ? undefined : { key, kind: "added" };
};

const hasCharacter = (entry: GlyphEntry, codePoints: ReadonlySet<number>) =>
  entry.characters.some((character) => codePoints.has(character));

/** A query read every way it can be meant. */
interface GlyphQuery {
  /** The code point the text spells, as in "U+0061" or "0061". */
  readonly codePoint: ReadonlySet<number>;
  /** True when the code point was written with U+ or 0x, so it cannot be a name. */
  readonly explicit: boolean;
  readonly glyphId: number | undefined;
  /** The single character typed, if the text is one character. */
  readonly literal: ReadonlySet<number>;
  /** Characters whose Unicode names match, each with its place in the results. */
  readonly named: ReadonlyMap<number, number>;
  readonly text: string;
}

const readQuery = (text: string, named: readonly number[]): GlyphQuery => {
  const typed = [...text];
  const glyphId = GLYPH_ID.exec(text)?.[1];
  return {
    codePoint: new Set([parseCodePoint(text) ?? -1]),
    explicit: EXPLICIT_CODE_POINT.test(text),
    glyphId: glyphId === undefined ? undefined : Number(glyphId),
    literal: new Set(
      typed.length === 1 ? [typed[0]?.codePointAt(0) ?? -1] : []
    ),
    named: new Map(
      named.map((codePoint, place) => [codePoint, place / (named.length + 1)])
    ),
    text: text.toLowerCase(),
  };
};

/** The glyph is exactly what was asked for: its character, its id, or its code point. */
const isAskedFor = (entry: GlyphEntry, query: GlyphQuery) =>
  hasCharacter(entry, query.literal) ||
  (entry.ref.kind === "source" && entry.ref.glyphId === query.glyphId) ||
  (query.explicit && hasCharacter(entry, query.codePoint));

const namedPlace = (
  entry: GlyphEntry,
  query: GlyphQuery
): number | undefined => {
  const places = entry.characters.flatMap((character) => {
    const place = query.named.get(character);
    return place === undefined ? [] : [place];
  });
  return places.length === 0 ? undefined : Math.min(...places);
};

/** Lower is better. Undefined when the glyph does not match at all. */
const rankOf = (entry: GlyphEntry, query: GlyphQuery): number | undefined => {
  if (isAskedFor(entry, query)) {
    return 0;
  }
  const name = entry.name.toLowerCase();
  if (name === query.text) {
    return 1;
  }
  if (hasCharacter(entry, query.codePoint)) {
    return 2;
  }
  const place = namedPlace(entry, query);
  if (place !== undefined) {
    return 3 + place;
  }
  if (name.startsWith(query.text)) {
    return 4;
  }
  return name.includes(query.text) ? 5 : undefined;
};

/**
 * The glyphs a query finds, best first. Every glyph for an empty query.
 *
 * - A single typed character finds the glyph it maps to.
 * - "U+0061" finds the glyph of that character; "#68" or "gid 68" a glyph id.
 * - Text finds glyph names: the exact name, then names that start with it,
 *   then names that contain it. Glyphs with no character are found this way.
 * - `named` holds characters whose Unicode names match the query, looked up
 *   by the caller; their glyphs come after exact matches.
 */
export const findGlyphs = (
  entries: readonly GlyphEntry[],
  text: string,
  named: readonly number[] = []
): readonly GlyphEntry[] => {
  const trimmed = text.trim();
  if (trimmed === "") {
    return entries;
  }
  const query = readQuery(trimmed, named);
  const ranked = entries.flatMap((entry) => {
    const rank = rankOf(entry, query);
    return rank === undefined ? [] : [{ entry, rank }];
  });
  // The sort is stable, so glyphs of equal rank stay in glyph order.
  return ranked.sort((a, b) => a.rank - b.rank).map(({ entry }) => entry);
};

const LETTER = /\p{L}/u;

/**
 * The glyph a face opens on when none was asked for: the first that draws a
 * letter, or failing that the first with any character, or the first glyph.
 */
export const startingGlyph = (
  entries: readonly GlyphEntry[]
): GlyphEntry | undefined =>
  entries.find((entry) =>
    entry.characters.some((character) =>
      LETTER.test(String.fromCodePoint(character))
    )
  ) ??
  entries.find((entry) => entry.characters.length > 0) ??
  entries[0];

const FIRST_VISIBLE = 0x21;

/**
 * What to call a glyph in a sentence: its character when it has one that
 * prints, otherwise its glyph name. Many fonts carry no glyph names, and a
 * made-up name such as gid45 says less than the letter does.
 */
export const spokenName = (entry: GlyphEntry): string => {
  const [character] = entry.characters;
  return character !== undefined && character >= FIRST_VISIBLE
    ? String.fromCodePoint(character)
    : entry.name;
};
