/** Reads what a face covers out of the workspace, for the library and the coverage explorer. */
import type { FaceId } from "~/typeface/face";
import { type TypefaceProject, workingFaceOf } from "~/typeface/project";
import type { OpenFace } from "~/typeface/reading";
import {
  type CharacterStatus,
  classifyFace,
  coverageByScript,
  type FaceClassification,
  type ScopeCoverage,
} from "~/unicode/coverage";

export interface FaceCoverage {
  /** Every script and shared group the face touches, the best covered first. */
  readonly byScope: readonly ScopeCoverage[];
  readonly classification: FaceClassification;
  /** True when the face can set the character: from the source, edited or added. */
  readonly has: (codePoint: number) => boolean;
  /**
   * True when the source font itself maps the character. Text set in the
   * browser's copy of the source font can show these and no others.
   */
  readonly inSource: (codePoint: number) => boolean;
}

/** A character the face can set, as opposed to a candidate or a gap. */
export const isCovered = (status: CharacterStatus) =>
  status === "source" || status === "edited" || status === "added";

/**
 * `source` is the face as the workspace opened it. The project supplies the
 * working face and the candidates, so edits and proposals count at once.
 */
export const readFaceCoverage = (
  project: TypefaceProject,
  faceId: FaceId,
  source: OpenFace
): FaceCoverage => {
  const classification = classifyFace({
    candidates: project.candidates.filter(
      (candidate) => candidate.faceId === faceId
    ),
    glyphForCharacter: (codePoint) => source.glyphForCharacter(codePoint),
    source: source.characters(),
    working: workingFaceOf(project, faceId),
  });
  return {
    byScope: coverageByScript(classification),
    classification,
    has: (codePoint) => isCovered(classification.classify(codePoint)),
    inSource: (codePoint) => source.glyphForCharacter(codePoint) !== undefined,
  };
};
