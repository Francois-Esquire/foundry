/**
 * Proposing the letters observed in evidence to a face: an editable face of
 * the project, or a new face made to hold them. The Reconstruct place's
 * session and the reconstruct command call this.
 */
import { sha256Hex } from "@foundry/lib/digest";
import { Refusal } from "~/lib/refusal";
import type { FontBuilder } from "~/packaging/building";
import { type FaceId, isEditable } from "~/typeface/face";
import { outlineToPath } from "~/typeface/outline";
import type { NewCandidate, TypefaceProject } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import {
  type Evidence,
  type RecoveredLetter,
  type RecoveryMetrics,
  recover,
  type Target,
} from "./core";
import {
  blankFileName,
  blankFontFor,
  type Destination,
  metricsOf,
} from "./destination";
import type { LetterReading } from "./reading";

/** What was proposed from evidence, and to which face. */
export interface Proposal {
  readonly faceId: FaceId;
  /**
   * Ids of letters that were proposed before with another outline, from
   * another marking of the same photograph. The project's candidate stands,
   * so that is the outline shown, and the fit of the newer tracing is not
   * its fit.
   */
  readonly kept: ReadonlySet<string>;
  /** The letters proposed, one for each distinct character, as the project holds them. */
  readonly letters: readonly RecoveredLetter[];
  readonly metrics: RecoveryMetrics;
  /** Letters left out because a candidate from this evidence already holds their place on another face. */
  readonly taken: number;
}

export interface ProposalRequest {
  /** Makes the empty font a new face's letters hang on. */
  readonly builder: Pick<FontBuilder, "blankFont">;
  readonly destination: Destination;
  readonly evidence: Evidence;
  readonly reading: LetterReading;
  readonly workspace: Workspace;
}

/** What a region with nothing in it comes to, wherever that is said. */
export const NO_LETTERS_FOUND =
  "No letters were found in this region. Change how the lettering is separated, or mark the region again.";

/** What to say, in every place that would propose or infer, once the destination face is gone. */
export const DESTINATION_GONE =
  "The face these letters were going to is no longer in the project. Choose a destination again, then propose the letters to it.";

/** True while the face a proposal's letters went to is still in the project. */
export const destinationStands = (
  proposal: Proposal,
  project: TypefaceProject
) => project.faces.some((face) => face.id === proposal.faceId);

/** The face's own lines, for letters that are scaled to them. */
export const targetFor = (
  workspace: Pick<Workspace, "openFace">,
  faceId: FaceId
): Target => {
  const face = workspace.openFace(faceId);
  return { face, faceId, metrics: metricsOf(face.description.metrics) };
};

const sameDesign = (a: NewCandidate, b: NewCandidate) =>
  a.advance === b.advance &&
  outlineToPath(a.outline) === outlineToPath(b.outline);

/** The face the letters go to. A new one is made, once, from an empty font of its name. */
const destinationFace = async ({
  builder,
  destination,
  workspace,
}: ProposalRequest): Promise<FaceId> => {
  const { project } = workspace.getState();
  if (destination.kind === "existing") {
    const face = project.faces.find(
      (candidate) => candidate.id === destination.faceId
    );
    if (!(face && isEditable(face))) {
      throw new Refusal(
        "Choose a face for the letters, or make a new face for them."
      );
    }
    return face.id;
  }
  if (destination.familyName.trim() === "") {
    throw new Refusal("Give the new face a name, then propose the letters.");
  }
  const built = await builder.blankFont(blankFontFor(destination.familyName));
  // The same name makes the same file, which the project already holds
  // when this reconstruction, or an earlier one of that name, made it.
  const sourceId = await sha256Hex(built.bytes);
  const existing = workspace
    .getState()
    .project.faces.find((face) => face.sourceId === sourceId);
  if (existing) {
    return existing.id;
  }
  const [report] = await workspace.importFonts([
    {
      bytes: built.bytes,
      madeFor: "reconstruction",
      name: blankFileName(destination.familyName),
    },
  ]);
  const faceId = report?.status === "imported" ? report.faceIds[0] : undefined;
  if (faceId === undefined) {
    throw new Refusal(
      "The new face could not be added to the project. Try another name."
    );
  }
  return faceId;
};

/**
 * Proposes one candidate for each distinct character read, scaled to the
 * destination face's lines. A letter of this evidence that the project
 * already holds a candidate for is not proposed twice. Refuses when no
 * letter was found, before any face is made, and when the destination is not
 * a face that takes letters.
 */
export const proposeLetters = async (
  request: ProposalRequest
): Promise<Proposal> => {
  const { evidence, reading, workspace } = request;
  if (reading.readings.length === 0) {
    throw new Refusal(NO_LETTERS_FOUND);
  }
  const faceId = await destinationFace(request);
  const target = targetFor(workspace, faceId);
  const { distinct } = recover(
    evidence,
    reading.sighting,
    reading.readings,
    target
  );
  const standing = new Map(
    workspace
      .getState()
      .project.candidates.map((candidate) => [candidate.id, candidate])
  );
  // A candidate's id names the evidence and the letter, not the face, so
  // one letter of one photograph can be proposed to one face only.
  const here = distinct.filter(
    ({ candidate }) => (standing.get(candidate.id)?.faceId ?? faceId) === faceId
  );
  const fresh = here.filter(({ candidate }) => !standing.has(candidate.id));
  const outcome =
    fresh.length > 0
      ? workspace.propose(fresh.map((letter) => letter.candidate))
      : undefined;
  if (outcome && !outcome.ok) {
    throw new Refusal(outcome.notice.message);
  }
  // A candidate cannot be withdrawn or proposed twice. Where one already
  // stands for a letter, it is what Accept adds, so it is what is shown.
  const kept = new Set<string>();
  const letters = here.map((letter): RecoveredLetter => {
    const held = standing.get(letter.candidate.id);
    if (!held || sameDesign(held, letter.candidate)) {
      return letter;
    }
    kept.add(held.id);
    const { status: _status, ...candidate } = held;
    return { ...letter, candidate };
  });
  return {
    faceId,
    kept,
    letters,
    metrics: target.metrics,
    taken: distinct.length - here.length,
  };
};
