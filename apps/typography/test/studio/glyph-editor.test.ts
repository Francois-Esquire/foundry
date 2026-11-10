import { beforeEach, describe, expect, it } from "vitest";
import { bearingsOf } from "~/studio/bearings";
import { createGlyphEditor, type GlyphEditor } from "~/studio/glyph-editor";
import { type GlyphRef, sourceGlyph } from "~/typeface/changes";
import { outlineBounds, outlinePoints } from "~/typeface/outline";
import { editablePoints, type PointAddress } from "~/typeface/outline-editing";
import type { Workspace } from "~/workspace/workspace";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

const LETTER_A = 0x61;
const node = (index: number, contour = 0): PointAddress => ({
  contour,
  kind: "node",
  node: index,
});

describe("the glyph editor", () => {
  let workspace: Workspace;
  let faceId: string;
  let glyph: GlyphRef;
  let editor: GlyphEditor;

  const revisions = () => workspace.getState().project.revisions;
  const head = () => workspace.getState().project.head;
  const recorded = () => {
    const shape = workspace.workingGlyph(faceId, glyph);
    if (!shape) {
      throw new Error("The glyph is gone.");
    }
    return shape;
  };
  const pointAt = (address: PointAddress) => {
    const found = editablePoints(recorded().outline).find(
      (point) => JSON.stringify(point.address) === JSON.stringify(address)
    );
    if (!found) {
      throw new Error("No such point.");
    }
    return found.point;
  };

  beforeEach(async () => {
    workspace = testWorkspace();
    ({ faceId } = await importOne(workspace, fixtureFile("lato")));
    glyph = sourceGlyph(
      workspace.openFace(faceId).glyphForCharacter(LETTER_A) ?? 0
    );
    editor = createGlyphEditor(workspace, { faceId, glyph, name: "a" });
  });

  describe("nudging", () => {
    it("shows each nudge at once and records nothing until the run ends", () => {
      const before = pointAt(node(0));
      editor.select([node(0)]);
      editor.nudge(1, 0);
      editor.nudge(0, 10);
      const shown = editablePoints(editor.shape()?.outline ?? { contours: [] });
      expect(shown[0]?.point).toEqual({ x: before.x + 1, y: before.y + 10 });
      expect(revisions()).toHaveLength(0);
      expect(pointAt(node(0))).toEqual(before);
    });

    it("records a run of nudges as one revision when it is flushed", () => {
      const before = pointAt(node(0));
      editor.select([node(0)]);
      editor.nudge(1, 0);
      editor.nudge(1, 0);
      editor.nudge(0, -10);
      editor.flush();
      expect(revisions()).toHaveLength(1);
      expect(revisions()[0]?.label).toBe("Move 1 point of a");
      expect(revisions()[0]?.changes.map((change) => change.kind)).toEqual([
        "outline-replaced",
      ]);
      expect(pointAt(node(0))).toEqual({ x: before.x + 2, y: before.y - 10 });
      expect(editor.getState().pending).toBeUndefined();
    });

    it("ends the run when the selection changes", () => {
      editor.select([node(0)]);
      editor.nudge(1, 0);
      editor.select([node(1)]);
      editor.nudge(1, 0);
      editor.flush();
      expect(revisions()).toHaveLength(2);
    });

    it("records nothing for a run that ends where it began", () => {
      editor.select([node(0)]);
      editor.nudge(10, 0);
      editor.nudge(-10, 0);
      editor.flush();
      expect(revisions()).toHaveLength(0);
    });

    it("does nothing with no selection", () => {
      editor.nudge(1, 0);
      editor.flush();
      expect(editor.getState().pending).toBeUndefined();
      expect(revisions()).toHaveLength(0);
    });

    it("flushes once however often it is asked", () => {
      editor.select([node(0)]);
      editor.nudge(1, 0);
      editor.flush();
      editor.flush();
      expect(revisions()).toHaveLength(1);
    });
  });

  describe("dragging", () => {
    it("moves the selection from where the drag began and records one revision", () => {
      const before = pointAt(node(2));
      editor.select([node(2), node(3)]);
      editor.beginDrag();
      editor.dragPoints(3.2, 4);
      editor.dragPoints(20.4, -7.6);
      expect(revisions()).toHaveLength(0);
      editor.endDrag();
      expect(revisions()).toHaveLength(1);
      expect(revisions()[0]?.label).toBe("Move 2 points of a");
      expect(pointAt(node(2))).toEqual({ x: before.x + 20, y: before.y - 8 });
    });

    it("records nothing for a drag that never moved", () => {
      editor.select([node(2)]);
      editor.beginDrag();
      editor.endDrag();
      expect(revisions()).toHaveLength(0);
    });

    it("ignores movement outside a drag", () => {
      editor.select([node(2)]);
      editor.dragPoints(50, 50);
      expect(editor.getState().pending).toBeUndefined();
    });

    it("drags a measure line and records where it was let go", () => {
      editor.beginDrag();
      editor.dragMeasure("advance", 1200);
      editor.dragMeasure("advance", 1250);
      expect(editor.shape()?.advance).toBe(1250);
      expect(recorded().advance).not.toBe(1250);
      editor.endDrag();
      expect(revisions()).toHaveLength(1);
      expect(revisions()[0]?.label).toBe("Set the advance of a to 1250");
      expect(recorded().advance).toBe(1250);
    });
  });

  describe("measures", () => {
    it("sets the advance as one change", () => {
      editor.setMeasure("advance", 1300);
      expect(revisions()[0]?.changes).toEqual([
        { advance: 1300, faceId, glyph, kind: "advance-changed" },
      ]);
    });

    it("records nothing when the value is what it already was", () => {
      editor.setMeasure("advance", recorded().advance);
      expect(revisions()).toHaveLength(0);
    });

    it("sets the left bearing as one revision that moves outline and advance", () => {
      const before = recorded();
      const bearings = bearingsOf(before);
      editor.setMeasure("left", (bearings?.left ?? 0) + 25);
      expect(revisions()).toHaveLength(1);
      expect(revisions()[0]?.changes.map((change) => change.kind)).toEqual([
        "outline-replaced",
        "advance-changed",
      ]);
      expect(recorded().advance).toBe(before.advance + 25);
      expect(bearingsOf(recorded())?.right).toBeCloseTo(bearings?.right ?? 0);
    });

    it("records a pending nudge before the measure, as two revisions", () => {
      editor.select([node(0)]);
      editor.nudge(1, 0);
      editor.setMeasure("advance", 1300);
      expect(revisions().map((revision) => revision.label)).toEqual([
        "Move 1 point of a",
        "Set the advance of a to 1300",
      ]);
    });
  });

  describe("nodes and segments", () => {
    it("adds a node on a segment and selects it", () => {
      const before = outlinePoints(recorded().outline).length;
      editor.addNode({ contour: 0, segment: 2, t: 0.5 });
      expect(revisions()[0]?.label).toBe("Add a node to a");
      expect(outlinePoints(recorded().outline).length).toBeGreaterThan(before);
      expect(editor.selection()).toEqual([node(3)]);
    });

    it("adds a node halfway along the selected segment", () => {
      editor.select([node(1)]);
      editor.addNode();
      expect(revisions()).toHaveLength(1);
      expect(editor.selection()).toEqual([node(2)]);
    });

    it("adds nothing when no segment is chosen", () => {
      editor.addNode();
      expect(revisions()).toHaveLength(0);
    });

    it("deletes the selected nodes and clears the selection", () => {
      const nodes = () =>
        editablePoints(recorded().outline).filter(
          (point) => point.address.kind === "node"
        ).length;
      const before = nodes();
      editor.select([node(1), node(4)]);
      editor.deleteSelected();
      expect(revisions()[0]?.label).toBe("Delete 2 nodes from a");
      expect(nodes()).toBe(before - 2);
      expect(editor.selection()).toEqual([]);
    });

    it("makes a selected segment straight, then curved again", () => {
      const handles = () =>
        editablePoints(recorded().outline).filter(
          (point) => point.address.kind === "handle"
        ).length;
      const curved = editablePoints(recorded().outline).find(
        (point) => point.address.kind === "handle"
      )?.address;
      if (curved?.kind !== "handle") {
        throw new Error("Lato's a has curves.");
      }
      const before = handles();
      editor.select([curved]);
      editor.convertSelected("line");
      expect(handles()).toBe(before - 1);
      expect(revisions()[0]?.label).toBe("Straighten a segment of a");
      editor.select([node(curved.segment, curved.contour)]);
      editor.convertSelected("cubic");
      expect(handles()).toBe(before + 1);
      expect(revisions()[1]?.label).toBe("Curve a segment of a");
    });
  });

  it("keeps the selection to points that still exist after an undo", () => {
    editor.addNode({ contour: 0, segment: 0, t: 0.5 });
    const count = editablePoints(recorded().outline).filter(
      (point) => point.address.kind === "node" && point.address.contour === 0
    ).length;
    editor.select([node(count - 1)]);
    workspace.undo();
    expect(editor.selection()).toEqual([]);
  });

  it("tells its listeners about every change it shows", () => {
    let calls = 0;
    const stop = editor.subscribe(() => {
      calls += 1;
    });
    editor.select([node(0)]);
    editor.nudge(1, 0);
    stop();
    editor.nudge(1, 0);
    expect(calls).toBe(2);
  });

  it("leaves the source font's bytes alone, and undo restores the source shape", () => {
    const [source] = workspace.getState().project.sources;
    const before = source?.bytes.slice();
    const bounds = outlineBounds(recorded().outline);
    editor.select([node(0)]);
    editor.nudge(40, 40);
    editor.setMeasure("left", 0);
    expect(head()).toBe(2);
    expect(source?.bytes).toEqual(before);
    workspace.undo();
    workspace.undo();
    expect(outlineBounds(recorded().outline)).toEqual(bounds);
  });
});
