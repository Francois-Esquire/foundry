import { useCallback, useMemo } from "react";
import type { Outline } from "~/typeface/outline";
import { Button } from "~/ui/controls/button";
import { Segmented } from "~/ui/controls/segmented";
import type { CanvasTool } from "./glyph-canvas";
import type { GlyphEditor } from "./glyph-editor";
import { type Selection, segmentsOf } from "./selection";

const TOOLS: readonly { label: string; value: CanvasTool }[] = [
  { label: "Select", value: "select" },
  { label: "Move view", value: "pan" },
];

interface CanvasToolbarProps {
  readonly editor: GlyphEditor;
  readonly onToolChange: (tool: CanvasTool) => void;
  readonly outline: Outline;
  readonly selection: Selection;
  readonly tool: CanvasTool;
}

/** The outline edits that act on the selection, and the choice of pointer tool. */
export function CanvasToolbar({
  editor,
  onToolChange,
  outline,
  selection,
  tool,
}: CanvasToolbarProps) {
  const hasSegment = useMemo(
    () => segmentsOf(outline, selection).length > 0,
    [outline, selection]
  );
  const hasNode = selection.some((address) => address.kind === "node");
  const addNode = useCallback(() => editor.addNode(), [editor]);
  const deleteNodes = useCallback(() => editor.deleteSelected(), [editor]);
  const straighten = useCallback(
    () => editor.convertSelected("line"),
    [editor]
  );
  const curve = useCallback(() => editor.convertSelected("cubic"), [editor]);
  return (
    <div className="ty-studio-toolbar">
      <Segmented
        label="Pointer"
        labelHidden
        onChange={onToolChange}
        options={TOOLS}
        value={tool}
      />
      <div className="ty-studio-row">
        <Button disabled={!hasSegment} onClick={addNode} symbol="add">
          Add node
        </Button>
        <Button disabled={!hasNode} onClick={deleteNodes} symbol="remove">
          Delete node
        </Button>
        <Button disabled={!hasSegment} onClick={straighten}>
          Make straight
        </Button>
        <Button disabled={!hasSegment} onClick={curve}>
          Make curved
        </Button>
      </div>
    </div>
  );
}
