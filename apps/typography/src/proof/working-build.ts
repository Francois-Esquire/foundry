/**
 * The build request for a face exactly as the project has it now: the whole
 * source font with the face's applied changes. This is a proof build. It is
 * not renamed and not checked against the licence, so it is never offered as
 * a download; exporting goes through an export plan.
 */
import type { BuildRequest } from "~/packaging/building";
import type { FaceId } from "~/typeface/face";
import {
  findFace,
  findSource,
  type TypefaceProject,
  workingFaceOf,
} from "~/typeface/project";

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
