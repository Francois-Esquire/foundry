/**
 * What a character selection comes to for one face, before anything is built:
 * how many characters it keeps, a floor for the glyph count, and what it
 * leaves out, grouped by writing system.
 */
import { scopeName, scopeOf } from "~/unicode/scope";

interface LeftOutGroup {
  readonly count: number;
  /** A script or shared group, for example Cyrillic or Punctuation. */
  readonly name: string;
}

export interface SelectionSummary {
  /** Characters the face has, added glyphs included. */
  readonly available: number;
  /**
   * The fewest glyphs the built font can have: the glyphs the kept characters
   * map to and the fallback glyph. Ligatures and alternates that kept features
   * reach are added by the build, so the real count is this or more.
   */
  readonly glyphFloor: number;
  /** True when every glyph is kept and the floor is the exact count. */
  readonly glyphsExact: boolean;
  readonly kept: number;
  /** Largest group first. */
  readonly leftOut: readonly LeftOutGroup[];
  readonly leftOutCount: number;
}

export interface SelectionInput {
  /** Every character the face has. */
  readonly available: Iterable<number>;
  /** The key of the glyph a font shows for a character it lacks. Always kept. */
  readonly fallbackGlyph: string;
  /** Every glyph of the face, added glyphs included. */
  readonly glyphCount: number;
  /** A key for the glyph a character maps to before shaping. */
  readonly glyphOf: (character: number) => string | undefined;
  /** The characters the plan keeps for this face. Undefined keeps everything. */
  readonly kept: Iterable<number> | undefined;
}

const OTHER = "Other characters";

const groupLeftOut = (characters: readonly number[]): LeftOutGroup[] => {
  const counts = new Map<string, number>();
  for (const character of characters) {
    const scope = scopeOf(character);
    const name = scope ? scopeName(scope) : OTHER;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ count, name }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en"));
};

export const summariseSelection = ({
  available,
  fallbackGlyph,
  glyphCount,
  glyphOf,
  kept,
}: SelectionInput): SelectionSummary => {
  const all = [...new Set(available)];
  if (kept === undefined) {
    return {
      available: all.length,
      glyphFloor: glyphCount,
      glyphsExact: true,
      kept: all.length,
      leftOut: [],
      leftOutCount: 0,
    };
  }
  const keptSet = new Set(kept);
  const leftOut = all.filter((character) => !keptSet.has(character));
  const glyphs = new Set([fallbackGlyph]);
  for (const character of keptSet) {
    const glyph = glyphOf(character);
    if (glyph !== undefined) {
      glyphs.add(glyph);
    }
  }
  return {
    available: all.length,
    glyphFloor: Math.min(glyphCount, glyphs.size),
    glyphsExact: false,
    kept: keptSet.size,
    leftOut: groupLeftOut(leftOut),
    leftOutCount: leftOut.length,
  };
};

/** A face and the selection the plan keeps from it. */
export interface FaceSelection {
  readonly faceId: string;
  readonly label: string;
  readonly summary: SelectionSummary;
}
