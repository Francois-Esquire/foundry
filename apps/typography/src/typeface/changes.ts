/**
 * Changes are the only way a project differs from its source fonts. A
 * revision is a labelled group of changes. Nothing here mutates a source.
 */
import type { FaceId } from "./face";
import type { Outline } from "./outline";
import type { Provenance } from "./provenance";
import type { GlyphShape } from "./reading";

/** A glyph is either one of the source font's glyphs or one the project added. */
export type GlyphRef =
  | { readonly kind: "source"; readonly glyphId: number }
  | { readonly kind: "added"; readonly key: string };

export const sourceGlyph = (glyphId: number): GlyphRef => ({
  glyphId,
  kind: "source",
});

export const addedGlyph = (key: string): GlyphRef => ({ key, kind: "added" });

export const glyphRefKey = (ref: GlyphRef) =>
  ref.kind === "source" ? `s:${ref.glyphId}` : `a:${ref.key}`;

export const sameGlyph = (a: GlyphRef, b: GlyphRef) =>
  glyphRefKey(a) === glyphRefKey(b);

export interface AddedGlyph {
  readonly advance: number;
  /** Characters mapped to this glyph. Empty for ligatures and other unmapped forms. */
  readonly characters: readonly number[];
  readonly key: string;
  /** The glyph's name in the built font and in feature code, for example ka-deva. */
  readonly name: string;
  readonly outline: Outline;
  readonly provenance: Provenance;
}

export type Change =
  | {
      readonly kind: "outline-replaced";
      readonly faceId: FaceId;
      readonly glyph: GlyphRef;
      readonly outline: Outline;
      /** Where the new outline came from. A hand edit when absent. */
      readonly provenance?: Provenance;
    }
  | {
      readonly kind: "advance-changed";
      readonly faceId: FaceId;
      readonly glyph: GlyphRef;
      readonly advance: number;
    }
  | {
      readonly kind: "glyph-added";
      readonly faceId: FaceId;
      readonly glyph: AddedGlyph;
    }
  | {
      readonly kind: "glyph-removed";
      readonly faceId: FaceId;
      readonly key: string;
    }
  | {
      readonly kind: "features-added";
      readonly faceId: FaceId;
      /** OpenType feature code that refers to glyphs by name. */
      readonly code: string;
      readonly description: string;
    };

export interface Revision {
  /** The candidate this revision accepted, when accepting one is what made it. */
  readonly accepts?: string;
  /** The run this revision accepted whole, when accepting one is what made it. */
  readonly acceptsRun?: string;
  readonly changes: readonly Change[];
  readonly createdAt: string;
  readonly id: string;
  readonly label: string;
}

/** Marks a branch the type system proves cannot run. */
export const unreachable = (value: never): never => {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
};

export interface GlyphOverride {
  readonly advance?: number;
  readonly outline?: Outline;
  /** Where the replacing outline came from. Absent when only the advance changed. */
  readonly provenance?: Provenance;
}

/** What a face's applied changes make of its glyphs: all a font is built from. */
export interface GlyphChanges {
  /** Added glyphs in the order they were added, with later edits applied. */
  readonly added: readonly AddedGlyph[];
  readonly featureCode: readonly string[];
  /** Overrides of source glyphs, keyed by glyph id. */
  readonly overrides: ReadonlyMap<number, GlyphOverride>;
}

/** A face's applied changes folded into one view. */
export interface WorkingFace extends GlyphChanges {
  /** Characters the project maps to an added glyph. */
  readonly characters: ReadonlyMap<number, string>;
}

/** The part of a working face a build takes. The character map is read back from the added glyphs. */
export const glyphChangesOf = ({
  added,
  featureCode,
  overrides,
}: WorkingFace): GlyphChanges => ({ added, featureCode, overrides });

export const EMPTY_WORKING_FACE: WorkingFace = {
  added: [],
  characters: new Map(),
  featureCode: [],
  overrides: new Map(),
};

const MANUAL: Provenance = { origin: "manual" };

/**
 * One face's changes being folded, oldest first. A commit checks each new
 * change against the fold and then applies it, so a long commit folds once.
 */
export interface ChangeFold {
  /** The added glyph that maps a character, if one does. */
  addedFor(character: number): AddedGlyph | undefined;
  apply(change: Change): void;
  hasAdded(key: string): boolean;
  hasAddedName(name: string): boolean;
  view(): WorkingFace;
}

export const startFold = (changes: readonly Change[] = []): ChangeFold => {
  const added = new Map<string, AddedGlyph>();
  const overrides = new Map<number, GlyphOverride>();
  const featureCode: string[] = [];

  const editGlyph = (glyph: GlyphRef, edit: GlyphOverride) => {
    if (glyph.kind === "source") {
      overrides.set(glyph.glyphId, {
        ...overrides.get(glyph.glyphId),
        ...edit,
      });
      return;
    }
    const current = added.get(glyph.key);
    if (current) {
      added.set(glyph.key, { ...current, ...edit });
    }
  };

  const fold: ChangeFold = {
    addedFor: (character) =>
      [...added.values()].findLast((glyph) =>
        glyph.characters.includes(character)
      ),
    apply(change) {
      switch (change.kind) {
        case "outline-replaced":
          // A redrawn outline carries the origin of the redraw, so a hand
          // edit of a generated glyph reads as a hand edit from then on.
          editGlyph(change.glyph, {
            outline: change.outline,
            provenance: change.provenance ?? MANUAL,
          });
          break;
        case "advance-changed":
          editGlyph(change.glyph, { advance: change.advance });
          break;
        case "glyph-added":
          added.set(change.glyph.key, change.glyph);
          break;
        case "glyph-removed":
          added.delete(change.key);
          break;
        case "features-added":
          featureCode.push(change.code);
          break;
        default:
          unreachable(change);
      }
    },
    hasAdded: (key) => added.has(key),
    hasAddedName: (name) =>
      [...added.values()].some((glyph) => glyph.name === name),
    view() {
      const glyphs = [...added.values()];
      const characters = new Map<number, string>();
      for (const glyph of glyphs) {
        for (const character of glyph.characters) {
          characters.set(character, glyph.key);
        }
      }
      return {
        added: glyphs,
        characters,
        featureCode: [...featureCode],
        overrides: new Map(overrides),
      };
    },
  };
  for (const change of changes) {
    fold.apply(change);
  }
  return fold;
};

/** Folds one face's changes, oldest first, into its working view. */
export const foldChanges = (changes: readonly Change[]): WorkingFace =>
  startFold(changes).view();

/** The glyph as the project currently has it: the source shape with edits applied. */
export const resolveGlyph = (
  working: WorkingFace,
  ref: GlyphRef,
  readSource: (glyphId: number) => GlyphShape
): GlyphShape | undefined => {
  if (ref.kind === "added") {
    const glyph = working.added.find((candidate) => candidate.key === ref.key);
    return glyph && { advance: glyph.advance, outline: glyph.outline };
  }
  const source = readSource(ref.glyphId);
  const override = working.overrides.get(ref.glyphId);
  return {
    advance: override?.advance ?? source.advance,
    outline: override?.outline ?? source.outline,
  };
};
