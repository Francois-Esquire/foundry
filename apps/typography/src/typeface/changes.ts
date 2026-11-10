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
}

/** A face's applied changes folded into one view. */
export interface WorkingFace {
  /** Added glyphs in the order they were added, with later edits applied. */
  readonly added: readonly AddedGlyph[];
  /** Characters the project maps to an added glyph. */
  readonly characters: ReadonlyMap<number, string>;
  readonly featureCode: readonly string[];
  /** Overrides of source glyphs, keyed by glyph id. */
  readonly overrides: ReadonlyMap<number, GlyphOverride>;
}

export const EMPTY_WORKING_FACE: WorkingFace = {
  added: [],
  characters: new Map(),
  featureCode: [],
  overrides: new Map(),
};

interface Folding {
  readonly added: Map<string, AddedGlyph>;
  readonly featureCode: string[];
  readonly overrides: Map<number, GlyphOverride>;
}

const applyGlyphEdit = (
  state: Folding,
  glyph: GlyphRef,
  edit: GlyphOverride
) => {
  if (glyph.kind === "source") {
    state.overrides.set(glyph.glyphId, {
      ...state.overrides.get(glyph.glyphId),
      ...edit,
    });
    return;
  }
  const current = state.added.get(glyph.key);
  if (current) {
    state.added.set(glyph.key, { ...current, ...edit });
  }
};

const applyChange = (state: Folding, change: Change) => {
  switch (change.kind) {
    case "outline-replaced":
      applyGlyphEdit(state, change.glyph, { outline: change.outline });
      break;
    case "advance-changed":
      applyGlyphEdit(state, change.glyph, { advance: change.advance });
      break;
    case "glyph-added":
      state.added.set(change.glyph.key, change.glyph);
      break;
    case "glyph-removed":
      state.added.delete(change.key);
      break;
    case "features-added":
      state.featureCode.push(change.code);
      break;
    default:
      unreachable(change);
  }
};

/** Folds one face's changes, oldest first, into its working view. */
export const foldChanges = (changes: readonly Change[]): WorkingFace => {
  const state: Folding = {
    added: new Map(),
    featureCode: [],
    overrides: new Map(),
  };
  for (const change of changes) {
    applyChange(state, change);
  }
  const added = [...state.added.values()];
  const characters = new Map<number, string>();
  for (const glyph of added) {
    for (const character of glyph.characters) {
      characters.set(character, glyph.key);
    }
  }
  return {
    added,
    characters,
    featureCode: state.featureCode,
    overrides: state.overrides,
  };
};

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
