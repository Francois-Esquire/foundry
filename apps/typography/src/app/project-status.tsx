import { useCallback } from "react";
import { canRedo, canUndo } from "~/typeface/project";
import { Button } from "~/ui/controls/button";
import { useWorkspace, useWorkspaceState } from "~/workspace/react";
import { useEngineStatus } from "~/workspace/services";

const count = (amount: number, singular: string) =>
  `${amount} ${singular}${amount === 1 ? "" : "s"}`;

const ENGINE_LINES = {
  failed: "Font engine did not start",
  idle: undefined,
  ready: "Font engine ready",
  starting: "Starting the font engine",
} as const;

/** The open project in one line, on the right of the masthead: what it holds, and undo. */
export function ProjectStatus() {
  const workspace = useWorkspace();
  const project = useWorkspaceState(useCallback((state) => state.project, []));
  const engine = ENGINE_LINES[useEngineStatus()];
  if (project.sources.length === 0) {
    return <span className="ty-label">No fonts yet</span>;
  }
  return (
    <>
      <span className="ty-label">
        {[
          count(project.sources.length, "font"),
          count(project.head, "revision"),
          engine,
        ]
          .filter(Boolean)
          .join(", ")}
      </span>
      <Button
        disabled={!canUndo(project)}
        onClick={workspace.undo}
        symbol="undo"
      >
        Undo
      </Button>
      <Button
        disabled={!canRedo(project)}
        onClick={workspace.redo}
        symbol="redo"
      >
        Redo
      </Button>
    </>
  );
}
