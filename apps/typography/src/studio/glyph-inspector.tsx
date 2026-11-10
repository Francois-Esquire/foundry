import { useCallback } from "react";
import type { TypefaceProject } from "~/typeface/project";
import type { GlyphShape } from "~/typeface/reading";
import { Button } from "~/ui/controls/button";
import { Segmented } from "~/ui/controls/segmented";
import { saveBytes } from "~/workspace/files";
import { useWorkspace } from "~/workspace/react";
import type { Measure } from "./bearings";
import type { GlyphEditor } from "./glyph-editor";
import { HistoryPanel } from "./history-panel";
import { MeasureTable } from "./measure-table";
import { useHistorySteps } from "./use-glyph-editor";

/** Over the source in ink, beside a still picture of the source, or the edit filled as it will print. */
export type Comparison = "alone" | "beside" | "over";

const COMPARISONS: readonly { label: string; value: Comparison }[] = [
  { label: "Over source", value: "over" },
  { label: "Beside source", value: "beside" },
  { label: "Edit alone", value: "alone" },
];

interface GlyphInspectorProps {
  /** False when there is no source to compare with, or nothing can be edited. */
  readonly canCompare: boolean;
  readonly comparison: Comparison;
  readonly editor: GlyphEditor | undefined;
  readonly onComparison: (comparison: Comparison) => void;
  /** The label of an edit that is under way. */
  readonly pending: string | undefined;
  readonly project: TypefaceProject;
  readonly shape: GlyphShape;
  /** The source font's file name, and the id it exports under. */
  readonly source: { readonly fileName: string; readonly id: string };
  /** What the source column shows. Absent for a glyph the project added. */
  readonly sourceShape: GlyphShape | undefined;
}

/**
 * Beside the drawing: the measure table, the revisions with undo and redo,
 * the comparison with the source, and the unchanged original to export.
 */
export function GlyphInspector({
  canCompare,
  comparison,
  editor,
  onComparison,
  pending,
  project,
  shape,
  source,
  sourceShape,
}: GlyphInspectorProps) {
  const workspace = useWorkspace();
  const { checkout, redo, undo } = useHistorySteps(workspace, editor);
  const setMeasure = useCallback(
    (measure: Measure, value: number) => editor?.setMeasure(measure, value),
    [editor]
  );
  const exportOriginal = useCallback(() => {
    const outcome = workspace.exportOriginal(source.id);
    if (outcome.ok) {
      saveBytes(outcome.value.fileName, outcome.value.bytes);
    }
  }, [source.id, workspace]);
  return (
    <div className="ty-studio-inspector">
      <h2 className="ty-label">Measures</h2>
      <MeasureTable
        onCommit={editor ? setMeasure : undefined}
        shape={shape}
        source={sourceShape}
      />
      <h2 className="ty-label">Revisions</h2>
      <HistoryPanel
        head={project.head}
        onCheckout={checkout}
        onRedo={redo}
        onUndo={undo}
        pending={pending}
        revisions={project.revisions}
      />
      <Segmented
        disabled={!canCompare}
        label="Compare with source"
        onChange={onComparison}
        options={COMPARISONS}
        value={comparison}
      />
      <div className="ty-studio-row">
        <Button onClick={exportOriginal} symbol="download">
          Export original
        </Button>
      </div>
      <p>
        The source font is never changed. {source.fileName} exports byte for
        byte as it was imported.
      </p>
    </div>
  );
}
