/**
 * Makes source fonts usable as CSS fonts, so specimens set real text in an
 * imported font. Each source font is registered under its own generated
 * family name and unregistered when it leaves the project.
 *
 * Limitation: a font built from bytes is one face, and CSS has no way to
 * pick a member of a font collection. Only the first face of a collection
 * gets a family; the others have none and must be drawn from their outlines.
 * How browsers treat collection bytes has not been tried in a real browser.
 */
import type { AxisLocation, FaceId, SourceId } from "~/typeface/face";
import type { WorkspaceState } from "./workspace";

/** Where fonts get registered. The browser's is `documentFontRegistry`; tests pass a fake. */
export interface FontRegistry {
  add(family: string, bytes: Uint8Array): void;
  remove(family: string): void;
}

export interface BrowserFonts {
  /**
   * The CSS family for a face, or undefined when the face has none. A
   * variable face and its pinned instances share one family: set the
   * location with `fontVariationSettings`.
   */
  familyFor(faceId: FaceId): string | undefined;
  /** Stops following the workspace and removes every registration. */
  stop(): void;
}

interface StateSource {
  getState(): WorkspaceState;
  subscribe(listener: () => void): () => void;
}

const FAMILY_ID_LENGTH = 12;

const familyNameFor = (sourceId: SourceId) =>
  `Typography Source ${sourceId.slice(0, FAMILY_ID_LENGTH)}`;

/** Registers the workspace's source fonts and keeps the registrations in step with it. */
export const followSourceFonts = (
  workspace: StateSource,
  registry: FontRegistry
): BrowserFonts => {
  const families = new Map<SourceId, string>();
  const reconcile = () => {
    const { sources } = workspace.getState().project;
    const present = new Set(sources.map((source) => source.id));
    for (const [sourceId, family] of families) {
      if (!present.has(sourceId)) {
        registry.remove(family);
        families.delete(sourceId);
      }
    }
    for (const source of sources) {
      if (!families.has(source.id)) {
        const family = familyNameFor(source.id);
        registry.add(family, source.bytes);
        families.set(source.id, family);
      }
    }
  };
  reconcile();
  const unsubscribe = workspace.subscribe(reconcile);
  return {
    familyFor(faceId) {
      const face = workspace
        .getState()
        .project.faces.find((candidate) => candidate.id === faceId);
      return face?.index === 0 ? families.get(face.sourceId) : undefined;
    },
    stop() {
      unsubscribe();
      for (const family of families.values()) {
        registry.remove(family);
      }
      families.clear();
    },
  };
};

/** A location as a CSS `font-variation-settings` value, for example `"wght" 700`. */
export const fontVariationSettings = (location: AxisLocation) =>
  Object.entries(location)
    .map(([tag, value]) => `"${tag}" ${value}`)
    .join(", ") || "normal";

/** Registers fonts with the CSS Font Loading API. */
export const documentFontRegistry = (
  fonts: FontFaceSet = document.fonts
): FontRegistry => {
  const registered = new Map<string, FontFace>();
  return {
    add(family, bytes) {
      const face = new FontFace(family, bytes as Uint8Array<ArrayBuffer>);
      registered.set(family, face);
      fonts.add(face);
      // A font the browser refuses stays unregistered; text falls back to the next family.
      face.load().catch(() => {
        fonts.delete(face);
      });
    },
    remove(family) {
      const face = registered.get(family);
      if (face) {
        fonts.delete(face);
        registered.delete(family);
      }
    },
  };
};
