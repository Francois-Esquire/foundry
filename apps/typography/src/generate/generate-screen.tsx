import "./generate.css";
import { useCallback } from "react";
import { isEditable } from "~/typeface/face";
import { EmptyState } from "~/ui/content/empty-state";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { useWorkspaceState } from "~/workspace/react";
import type { WorkspaceState } from "~/workspace/workspace";
import { FamilyPlace } from "./family/family-place";
import { canCoordinate, weightAxisOf } from "./family/weights";
import { GeneratePlace } from "./generate-place";
import { ScriptExtensionRoute } from "./script-extension/script-extension-route";
import { useProject } from "./use-session";

/**
 * Generate: draw the characters a face lacks through the generation
 * pipeline, watch the stages, and decide on each candidate. It works on the
 * face every place looks at, when that face can be edited.
 */
export default function GenerateScreen({
  path,
}: {
  readonly path: readonly string[];
}) {
  const project = useProject();
  const activeFaceId = useWorkspaceState(
    useCallback((state: WorkspaceState) => state.activeFaceId, [])
  );
  if (project.faces.length === 0) {
    return (
      <EmptyState
        action={
          <ButtonLink href="#/import" symbol="add">
            Import a font
          </ButtonLink>
        }
        symbol="generate"
        title="No fonts yet"
      >
        Generate draws the characters a face is missing and proposes them as
        candidates. Import a font, or load the samples, to begin.
      </EmptyState>
    );
  }
  const editable = project.faces.filter(isEditable);
  const active = project.faces.find((known) => known.id === activeFaceId);
  // A variable face with a weight axis is worked on across weights. With no
  // editable face to fall back on, the first such face is.
  const coordinated =
    active && canCoordinate(active)
      ? active
      : editable.length === 0 && project.faces.find(canCoordinate);
  const axis = coordinated ? weightAxisOf(coordinated) : undefined;
  if (coordinated && axis) {
    return <FamilyPlace axis={axis} face={coordinated} key={coordinated.id} />;
  }
  const face =
    editable.find((known) => known.id === activeFaceId) ?? editable[0];
  if (!face) {
    return (
      <EmptyState
        action={<ButtonLink href="#/library">Go to the Library</ButtonLink>}
        symbol="generate"
        title="No editable face"
      >
        Every face in the project is variable, and a variable face takes no new
        glyphs. Pin an instance of one in the Library, then generate for the
        pinned instance.
      </EmptyState>
    );
  }
  return (
    <>
      {active && active.id !== face.id ? (
        <Notice>
          {active.description.fullName} is a variable face and takes no new
          glyphs. Generating for {face.description.fullName} instead. Pin an
          instance in the Library to generate for it.
        </Notice>
      ) : null}
      <ScriptExtensionRoute face={face} path={path}>
        <GeneratePlace face={face} key={face.id} />
      </ScriptExtensionRoute>
    </>
  );
}
