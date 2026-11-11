import { useCallback } from "react";
import { count } from "~/lib/count";
import type { EngineStatus } from "~/packaging/engine/client";
import { canRedo, canUndo, type TypefaceProject } from "~/typeface/project";
import { Button } from "~/ui/controls/button";
import { useWorkspace, useWorkspaceState } from "~/workspace/react";
import { useEngineStatus } from "~/workspace/services";

const ENGINE_LINES: Readonly<Record<EngineStatus, string>> = {
  failed: "Font engine did not start",
  idle: "Font engine not started",
  ready: "Font engine ready",
  starting: "Starting the font engine",
};

/**
 * The open project in one line: fonts, applied revisions, candidates waiting
 * for a decision, and where the font engine stands. An empty project says so,
 * and names the engine only once something has started it.
 */
export const statusLine = (
  project: TypefaceProject,
  engine: EngineStatus
): string => {
  if (project.sources.length === 0) {
    return engine === "idle"
      ? "No fonts yet"
      : `No fonts yet, ${ENGINE_LINES[engine]}`;
  }
  const waiting = project.candidates.filter(
    (candidate) => candidate.status === "proposed"
  ).length;
  return [
    count(project.sources.length, "font"),
    count(project.head, "revision"),
    waiting > 0
      ? `${waiting} ${waiting === 1 ? "candidate" : "candidates"} waiting`
      : undefined,
    ENGINE_LINES[engine],
  ]
    .filter((part) => part !== undefined)
    .join(", ");
};

/** The open project on the right of the masthead: what it holds, and undo. */
export function ProjectStatus() {
  const workspace = useWorkspace();
  const project = useWorkspaceState(useCallback((state) => state.project, []));
  const engine = useEngineStatus();
  const line = <span className="ty-label">{statusLine(project, engine)}</span>;
  if (project.sources.length === 0) {
    return line;
  }
  return (
    <>
      {line}
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
