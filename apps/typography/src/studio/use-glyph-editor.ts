import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { GlyphRef } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import type { Workspace } from "~/workspace/workspace";
import {
  createGlyphEditor,
  type GlyphEditor,
  type GlyphEditorState,
} from "./glyph-editor";
import { EMPTY_SELECTION } from "./selection";

const NOT_EDITING: GlyphEditorState = { selection: EMPTY_SELECTION };
const notEditing = () => NOT_EDITING;
const neverChanges = () => () => undefined;

interface EditedGlyph {
  /** Undefined when the glyph can only be looked at. */
  readonly editor: GlyphEditor | undefined;
  readonly state: GlyphEditorState;
}

/**
 * An editor for one glyph, replaced when the face or glyph changes. An edit
 * still under way is recorded when the editor goes away, so leaving a glyph
 * mid-nudge loses nothing.
 */
export const useGlyphEditor = (
  workspace: Workspace,
  faceId: FaceId,
  glyph: GlyphRef,
  name: string,
  editable: boolean
): EditedGlyph => {
  const editor = useMemo(
    () =>
      editable
        ? createGlyphEditor(workspace, { faceId, glyph, name })
        : undefined,
    [editable, faceId, glyph, name, workspace]
  );
  useEffect(() => () => editor?.flush(), [editor]);
  const state = useSyncExternalStore(
    editor?.subscribe ?? neverChanges,
    editor?.getState ?? notEditing
  );
  return { editor, state };
};

/**
 * Undo, redo and stepping to a revision. An edit still under way becomes a
 * revision first, so undo undoes it instead of silently dropping it.
 */
export const useHistorySteps = (
  workspace: Workspace,
  editor: GlyphEditor | undefined
) => {
  const undo = useCallback(() => {
    editor?.flush();
    workspace.undo();
  }, [editor, workspace]);
  const redo = useCallback(() => {
    editor?.flush();
    workspace.redo();
  }, [editor, workspace]);
  const checkout = useCallback(
    (head: number) => {
      editor?.flush();
      workspace.checkout(head);
    },
    [editor, workspace]
  );
  return { checkout, redo, undo };
};
