/** Everything the inspector shows about one character in one face, read from the workspace. */
import { type GlyphRef, glyphRefKey } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import { type Bounds, type Outline, outlineBounds } from "~/typeface/outline";
import type { Candidate } from "~/typeface/project";
import type { Provenance } from "~/typeface/provenance";
import type { GlyphShape } from "~/typeface/reading";
import type { CharacterStatus } from "~/unicode/coverage";
import type { Workspace } from "~/workspace/workspace";

export interface InspectedGlyph {
  readonly advance: number;
  /** Undefined for a glyph that draws nothing, such as a space. */
  readonly bounds: Bounds | undefined;
  /** "Glyph 56" for a source glyph, "Added glyph" or "Candidate" otherwise. */
  readonly identity: string;
  readonly name: string;
  readonly outline: Outline;
  /** Present for added and redrawn glyphs and for candidates: where the design came from. */
  readonly provenance: Provenance | undefined;
  /** Other characters that map to this same glyph, ascending. */
  readonly sharedWith: readonly number[];
}

export interface Inspection {
  readonly codePoint: number;
  /** Undefined when the face has nothing for the character. */
  readonly glyph: InspectedGlyph | undefined;
  readonly status: CharacterStatus;
}

type GlyphReading = Pick<
  Workspace,
  "glyphForCharacter" | "glyphsOf" | "workingGlyph"
>;

const identityOf = (ref: GlyphRef) =>
  ref.kind === "source" ? `Glyph ${ref.glyphId}` : "Added glyph";

const inFace = (
  workspace: GlyphReading,
  faceId: FaceId,
  codePoint: number
): InspectedGlyph | undefined => {
  const ref = workspace.glyphForCharacter(faceId, codePoint);
  const shape = ref && workspace.workingGlyph(faceId, ref);
  if (!(ref && shape)) {
    return;
  }
  const key = glyphRefKey(ref);
  const entry = workspace
    .glyphsOf(faceId)
    .find((candidate) => glyphRefKey(candidate.ref) === key);
  return {
    advance: shape.advance,
    bounds: outlineBounds(shape.outline),
    identity: identityOf(ref),
    name: entry?.name ?? "",
    outline: shape.outline,
    provenance: entry?.provenance,
    sharedWith: (entry?.characters ?? []).filter(
      (other) => other !== codePoint
    ),
  };
};

/** The proposed candidate that offers a character, as the face's coverage resolves it. */
type ProposalFor = (codePoint: number) => Candidate | undefined;

const proposedGlyph = (
  candidate: Candidate | undefined,
  codePoint: number
): InspectedGlyph | undefined =>
  candidate && {
    advance: candidate.advance,
    bounds: outlineBounds(candidate.outline),
    identity: "Candidate",
    name: candidate.name,
    outline: candidate.outline,
    provenance: candidate.provenance,
    sharedWith: candidate.characters.filter((other) => other !== codePoint),
  };

/**
 * The shape to draw for a character: the proposed design for a candidate,
 * otherwise the glyph it maps to as the project has it.
 */
export const characterShape = (
  workspace: Pick<Workspace, "glyphForCharacter" | "workingGlyph">,
  proposalFor: ProposalFor,
  faceId: FaceId,
  codePoint: number,
  status: CharacterStatus
): GlyphShape | undefined => {
  if (status === "missing") {
    return;
  }
  if (status === "candidate") {
    return proposalFor(codePoint);
  }
  const ref = workspace.glyphForCharacter(faceId, codePoint);
  return ref && workspace.workingGlyph(faceId, ref);
};

/**
 * A covered character shows the glyph it maps to as the project has it. A
 * candidate shows the proposed design. A missing character shows no glyph.
 */
export const inspectCharacter = (
  workspace: GlyphReading,
  proposalFor: ProposalFor,
  faceId: FaceId,
  codePoint: number,
  status: CharacterStatus
): Inspection => {
  if (status === "missing") {
    return { codePoint, glyph: undefined, status };
  }
  return {
    codePoint,
    glyph:
      status === "candidate"
        ? proposedGlyph(proposalFor(codePoint), codePoint)
        : inFace(workspace, faceId, codePoint),
    status,
  };
};
