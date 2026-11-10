import { useMemo } from "react";
import {
  type GlyphRef,
  glyphRefKey,
  type WorkingFace,
} from "~/typeface/changes";
import { type AxisLocation, type Face, isEditable } from "~/typeface/face";
import { type TypefaceProject, workingFaceOf } from "~/typeface/project";
import type { GlyphShape } from "~/typeface/reading";
import type { GlyphEntry } from "~/workspace/glyphs";
import { useWorkspace } from "~/workspace/react";
import { withGlyphShape } from "./glyph-changes";
import type { GlyphEditor, PendingEdit } from "./glyph-editor";
import { spokenName } from "./glyph-finding";
import type { Selection } from "./selection";
import { useGlyphEditor } from "./use-glyph-editor";

export interface OpenGlyph {
  /** Undefined for a glyph of a variable face, which is only looked at. */
  readonly editor: GlyphEditor | undefined;
  readonly glyph: GlyphRef;
  /** True when the glyph differs from the source font, or is being changed now. */
  readonly made: boolean;
  /** What to call the glyph in a sentence. */
  readonly name: string;
  /** The edit under way that is not a revision yet. */
  readonly pending: PendingEdit | undefined;
  readonly selection: Selection;
  /** The glyph as it is drawn now. Undefined when the face no longer has it. */
  readonly shape: GlyphShape | undefined;
  /** The glyph in the source font. Absent for a glyph the project added. */
  readonly source: GlyphShape | undefined;
  /** The working face with the edit under way laid over it. */
  readonly working: WorkingFace;
}

/**
 * One glyph of a face, open for editing: its editor, its shape with the
 * edit under way, and the working face that shows that edit in text.
 */
export const useOpenGlyph = (
  project: TypefaceProject,
  face: Face,
  entry: GlyphEntry,
  location: AxisLocation
): OpenGlyph => {
  const workspace = useWorkspace();
  const editable = isEditable(face);
  // One object per glyph, so the editor and its selection outlive project changes.
  const glyphKey = glyphRefKey(entry.ref);
  const glyph = useMemo(() => entry.ref, [glyphKey]);
  const name = spokenName(entry);
  const { editor, state } = useGlyphEditor(
    workspace,
    face.id,
    glyph,
    name,
    editable
  );
  const { pending } = state;
  const working = useMemo(
    () => workingFaceOf(project, face.id),
    [face.id, project]
  );
  const shown = useMemo(
    () => (pending ? withGlyphShape(working, glyph, pending.shape) : working),
    [glyph, pending, working]
  );
  const openFace = workspace.openFace(face.id);
  const source = useMemo(
    () => (glyph.kind === "source" ? openFace.glyph(glyph.glyphId) : undefined),
    [glyph, openFace]
  );
  // A variable face is drawn wherever its axes are set, straight from the font.
  const preview = useMemo(
    () =>
      !editable && glyph.kind === "source"
        ? openFace.glyph(glyph.glyphId, location)
        : undefined,
    [editable, glyph, location, openFace]
  );
  const recorded = useMemo(
    () => workspace.workingGlyph(face.id, glyph),
    [face.id, glyph, project, workspace]
  );
  const shape = preview ?? pending?.shape ?? recorded;
  return {
    editor,
    glyph,
    made:
      editable &&
      (glyph.kind === "added" ||
        working.overrides.has(glyph.glyphId) ||
        pending !== undefined),
    name,
    pending,
    selection: editor?.selection() ?? state.selection,
    shape,
    source,
    working: shown,
  };
};
