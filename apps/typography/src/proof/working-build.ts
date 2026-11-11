/**
 * Building a face exactly as the project has it now: the whole source font
 * with the face's applied changes. This is a proof build. It is not renamed
 * and not checked against the licence, so it is never offered as a download;
 * exporting goes through an export plan.
 */
import { keptCharacters } from "~/export/build-run";
import { shapingSamples } from "~/export/shaping-samples";
import type { BuildRequest, FontBuilder } from "~/packaging/building";
import type { FaceId } from "~/typeface/face";
import {
  findFace,
  findSource,
  type TypefaceProject,
  workingFaceOf,
} from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import type { BuiltWorkingFace } from "./working-builds";

export const workingRequest = (
  project: TypefaceProject,
  faceId: FaceId
): BuildRequest => {
  const face = findFace(project, faceId);
  const working = workingFaceOf(project, faceId);
  return {
    added: working.added,
    faceIndex: face.index,
    featureCode: working.featureCode,
    location: face.pinned?.location,
    overrides: working.overrides,
    source: findSource(project, face.sourceId).bytes,
    styleName: face.pinned?.styleName,
  };
};

export interface WorkingBuildRequest {
  readonly builder: Pick<FontBuilder, "build">;
  readonly faceId: FaceId;
  /** What the face is called, which the built font is named after. */
  readonly label: string;
  readonly newId: () => string;
  /** The current time as an ISO 8601 string. */
  readonly now: () => string;
  readonly workspace: Pick<Workspace, "getState" | "openFace">;
}

/**
 * Builds a working face and answers with the font as a proof takes it: with
 * the time it was built, an id of its own, and the shaping samples of the
 * characters it keeps. The project is read when the build is asked for, so
 * the answer says what the font was built from whatever changes meanwhile.
 */
export const buildWorkingFace = async ({
  builder,
  faceId,
  label,
  newId,
  now,
  workspace,
}: WorkingBuildRequest): Promise<BuiltWorkingFace> => {
  const { project } = workspace.getState();
  const request = workingRequest(project, faceId);
  const built = await builder.build(request);
  return {
    font: {
      builtAt: now(),
      bytes: built.bytes,
      exported: false,
      faceId,
      fileName: `${label}, working face`,
      id: newId(),
      request,
      samples: shapingSamples(
        keptCharacters(request, workspace.openFace(faceId).characters())
      ),
    },
    project,
  };
};
