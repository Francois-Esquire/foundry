/**
 * One glyph under the pen. The editor holds the selection and the edit that
 * is under way, and turns every finished edit into exactly one revision: a
 * drag is one, a run of nudges is one, and an edit that ends where it began
 * is none. The source font is never touched; edits go to the workspace as
 * changes.
 */

import { count } from "~/lib/count";
import { createStore } from "~/lib/store";
import type { GlyphRef } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import {
  convertSegment,
  insertNode,
  movePoints,
} from "~/typeface/outline-editing";
import type { GlyphShape } from "~/typeface/reading";
import type { Workspace } from "~/workspace/workspace";
import { type Measure, measureOf, withMeasure } from "./bearings";
import { changesBetween } from "./glyph-changes";
import { deleteNodes } from "./node-removal";
import {
  EMPTY_SELECTION,
  keepExisting,
  type SegmentAddress,
  type Selection,
  segmentsOf,
  selectionKey,
} from "./selection";

export interface EditTarget {
  readonly faceId: FaceId;
  readonly glyph: GlyphRef;
  /** The glyph's name, for revision labels. */
  readonly name: string;
}

/** An edit that shows on screen and is not a revision yet. */
export interface PendingEdit {
  readonly label: string;
  readonly run: "drag" | "nudge";
  readonly shape: GlyphShape;
}

export interface GlyphEditorState {
  readonly pending?: PendingEdit;
  readonly selection: Selection;
}

export interface NodePlace extends SegmentAddress {
  /** Position along the segment, from 0 to 1. */
  readonly t: number;
}

export interface GlyphEditor {
  /** Adds a node at a place on the outline, or halfway along the selected segment. */
  addNode(place?: NodePlace): void;
  /** Starts a drag from the glyph as the project has it. */
  beginDrag(): void;
  /** Makes the selected segments straight or curved. */
  convertSelected(kind: "cubic" | "line"): void;
  deleteSelected(): void;
  /** Shows a measure at a value while its line is dragged. */
  dragMeasure(measure: Measure, value: number): void;
  /** Shows the selection moved by a distance from where the drag began. */
  dragPoints(dx: number, dy: number): void;
  /** Ends the drag and records it. */
  endDrag(): void;
  /** Records the edit under way, if there is one. Safe to call at any time. */
  flush(): void;
  getState(): GlyphEditorState;
  /** Moves the selection. Nudges of the same selection in a row make one revision. */
  nudge(dx: number, dy: number): void;
  select(selection: Selection): void;
  /** The selection, without points the glyph no longer has. */
  selection(): Selection;
  setMeasure(measure: Measure, value: number): void;
  /** The glyph as it is drawn now, the edit under way included. */
  shape(): GlyphShape | undefined;
  subscribe(listener: () => void): () => void;
}

const MEASURE_NAMES: Readonly<Record<Measure, string>> = {
  advance: "advance",
  left: "left bearing",
  right: "right bearing",
};

const measureLabel = (name: string, measure: Measure, shape: GlyphShape) => {
  const value = measureOf(shape, measure);
  const reached = value === undefined ? "" : ` to ${Math.round(value)}`;
  return `Set the ${MEASURE_NAMES[measure]} of ${name}${reached}`;
};

export const createGlyphEditor = (
  workspace: Pick<Workspace, "apply" | "workingGlyph">,
  target: EditTarget
): GlyphEditor => {
  const { faceId, glyph, name } = target;
  const store = createStore<GlyphEditorState>({ selection: EMPTY_SELECTION });
  let dragFrom: GlyphShape | undefined;
  let nudged = "";

  const { setState } = store;

  const recorded = () => workspace.workingGlyph(faceId, glyph);
  const shape = () => store.getState().pending?.shape ?? recorded();
  const selection = () => {
    const current = shape();
    return current
      ? keepExisting(current.outline, store.getState().selection)
      : EMPTY_SELECTION;
  };

  const commit = (label: string, from: GlyphShape, to: GlyphShape) => {
    const changes = changesBetween(faceId, glyph, from, to);
    return changes.length === 0 || workspace.apply(label, changes).ok;
  };

  const flush = () => {
    const { pending } = store.getState();
    dragFrom = undefined;
    if (!pending) {
      return;
    }
    const from = recorded();
    if (from) {
      commit(pending.label, from, pending.shape);
    }
    setState({ selection: store.getState().selection });
  };

  /** Records a whole edit at once and then moves the selection. */
  const edit = (
    label: (to: GlyphShape) => string,
    change: (from: GlyphShape, selected: Selection) => GlyphShape,
    select?: Selection
  ) => {
    flush();
    const from = recorded();
    if (!from) {
      return;
    }
    const to = change(
      from,
      keepExisting(from.outline, store.getState().selection)
    );
    if (commit(label(to), from, to) && select) {
      setState({ selection: select });
    }
  };

  const show = (pending: PendingEdit) =>
    setState({ pending, selection: store.getState().selection });

  return {
    addNode(place) {
      const current = recorded();
      const at =
        place ??
        (current && {
          ...segmentsOf(current.outline, selection())[0],
          t: 0.5,
        });
      if (at?.contour === undefined || at.segment === undefined) {
        return;
      }
      const { contour, segment, t } = at;
      edit(
        () => `Add a node to ${name}`,
        (from) => ({
          ...from,
          outline: insertNode(from.outline, contour, segment, t),
        }),
        [{ contour, kind: "node", node: segment + 1 }]
      );
    },
    beginDrag() {
      flush();
      dragFrom = recorded();
    },
    convertSelected(kind) {
      edit(
        () =>
          `${kind === "line" ? "Straighten" : "Curve"} a segment of ${name}`,
        (from, selected) => ({
          ...from,
          outline: segmentsOf(from.outline, selected).reduce(
            (outline, { contour, segment }) =>
              convertSegment(outline, contour, segment, kind),
            from.outline
          ),
        })
      );
    },
    deleteSelected() {
      const nodes = selection().filter((address) => address.kind === "node");
      if (nodes.length === 0) {
        return;
      }
      edit(
        () => `Delete ${count(nodes.length, "node")} from ${name}`,
        (from, selected) => ({
          ...from,
          outline: deleteNodes(from.outline, selected),
        }),
        EMPTY_SELECTION
      );
    },
    dragMeasure(measure, value) {
      if (!dragFrom) {
        return;
      }
      const moved = withMeasure(dragFrom, measure, value);
      show({
        label: measureLabel(name, measure, moved),
        run: "drag",
        shape: moved,
      });
    },
    dragPoints(dx, dy) {
      if (!dragFrom) {
        return;
      }
      const selected = keepExisting(
        dragFrom.outline,
        store.getState().selection
      );
      if (selected.length === 0) {
        return;
      }
      show({
        label: `Move ${count(selected.length, "point")} of ${name}`,
        run: "drag",
        shape: {
          ...dragFrom,
          outline: movePoints(
            dragFrom.outline,
            selected,
            Math.round(dx),
            Math.round(dy)
          ),
        },
      });
    },
    endDrag: flush,
    flush,
    getState: store.getState,
    nudge(dx, dy) {
      const selected = selection();
      if (selected.length === 0) {
        return;
      }
      const key = selectionKey(selected);
      if (store.getState().pending?.run !== "nudge" || nudged !== key) {
        flush();
      }
      const from = shape();
      if (!from) {
        return;
      }
      nudged = key;
      show({
        label: `Move ${count(selected.length, "point")} of ${name}`,
        run: "nudge",
        shape: {
          ...from,
          outline: movePoints(from.outline, selected, dx, dy),
        },
      });
    },
    select(next) {
      flush();
      setState({ selection: next });
    },
    selection,
    setMeasure(measure, value) {
      edit(
        (to) => measureLabel(name, measure, to),
        (from) => withMeasure(from, measure, value)
      );
    },
    shape,
    subscribe: store.subscribe,
  };
};
