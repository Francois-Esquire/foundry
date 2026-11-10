import "./generate.css";
import { useCallback, useEffect, useMemo } from "react";
import { isEditable } from "~/typeface/face";
import { EmptyState } from "~/ui/content/empty-state";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { useWorkspace, useWorkspaceState } from "~/workspace/react";
import type { WorkspaceState } from "~/workspace/workspace";
import { FamilyPlace } from "./family/family-place";
import { canCoordinate, weightAxisOf } from "./family/weights";
import { type GenerateAddress, readGeneratePath } from "./generate-address";
import { GeneratePlace } from "./generate-place";
import { scopeOptionKey } from "./missing-characters";
import { ScriptExtensionRoute } from "./script-extension/script-extension-route";
import { useGenerateSession, useProject } from "./use-session";

/**
 * Puts the choice an address carries into the place, once on arriving and
 * again whenever the address changes: the face becomes the one every place
 * looks at, and a writing system becomes the request for what the face
 * lacks in it. A bare "#/generate" asks for nothing.
 */
const useArrival = ({ faceId, scope }: GenerateAddress) => {
  const workspace = useWorkspace();
  const session = useGenerateSession();
  useEffect(() => {
    const { activeFaceId, project } = workspace.getState();
    if (
      faceId !== undefined &&
      faceId !== activeFaceId &&
      project.faces.some((known) => known.id === faceId)
    ) {
      workspace.setActiveFace(faceId);
    }
    const key = scope && scopeOptionKey(scope);
    if (key !== undefined) {
      session.updateDraft({ scope: key, source: "script" });
    }
  }, [faceId, scope, session, workspace]);
};

/** What an address names that the place could not follow, with the way on. */
const missOf = (
  { faceId, unknownScope }: GenerateAddress,
  known: boolean
): string | undefined => {
  if (faceId !== undefined && !known) {
    return "The face in this address is not in the project. Choose a face below.";
  }
  return unknownScope === undefined
    ? undefined
    : `No writing system is called ${unknownScope}. Choose the characters to generate below.`;
};

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
  const address = useMemo(() => readGeneratePath(path), [path]);
  useArrival(address);
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
  const miss = missOf(
    address,
    project.faces.some((known) => known.id === address.faceId)
  );
  const missed = miss ? <Notice>{miss}</Notice> : null;
  if (coordinated && axis) {
    return (
      <>
        {missed}
        <FamilyPlace axis={axis} face={coordinated} key={coordinated.id} />
      </>
    );
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
      {missed}
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
