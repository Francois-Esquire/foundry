import { studioHash } from "~/studio/studio-address";
import { addedGlyph } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import type { NewCandidate } from "~/typeface/project";

/** Opens the accepted candidate's replacement or added glyph in its face. */
export const candidateStudioHash = (
  faceId: FaceId,
  candidate: Pick<NewCandidate, "id" | "replaces">
): string => studioHash(faceId, candidate.replaces ?? addedGlyph(candidate.id));
