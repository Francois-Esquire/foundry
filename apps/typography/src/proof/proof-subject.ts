/**
 * What the Proof place can prove: a font the Export place built, or a face
 * as the project has it now, built on demand. The address names which.
 */

import type { KeptScriptSample } from "~/export/shaping-samples";
import type { BuildRequest } from "~/packaging/building";
import type { FaceId } from "~/typeface/face";

export type SubjectRef =
  | { readonly kind: "built"; readonly id: string }
  | { readonly kind: "face"; readonly faceId: FaceId };

/** A built font with everything a proof needs to compare it with its source. */
export interface ProofFont {
  readonly builtAt: string;
  readonly bytes: Uint8Array;
  /**
   * False for a working face built here: it is not renamed or checked against
   * the licence, so it is a proof and not an export.
   */
  readonly exported: boolean;
  readonly faceId: FaceId;
  readonly fileName: string;
  /** Distinct for every build, so a font registered with the browser is never reused. */
  readonly id: string;
  readonly request: BuildRequest;
  readonly samples: readonly KeptScriptSample[];
}

/** Reads "#/proof/built/<id>" and "#/proof/face/<face>". Anything else names nothing. */
export const subjectOfPath = (
  path: readonly string[]
): SubjectRef | undefined => {
  const [kind, id] = path;
  if (id === undefined) {
    return;
  }
  if (kind === "built") {
    return { id, kind: "built" };
  }
  return kind === "face" ? { faceId: id, kind: "face" } : undefined;
};

export const subjectKey = (subject: SubjectRef) =>
  subject.kind === "built" ? `built:${subject.id}` : `face:${subject.faceId}`;

export const subjectOfKey = (key: string): SubjectRef | undefined => {
  const separator = key.indexOf(":");
  return subjectOfPath([key.slice(0, separator), key.slice(separator + 1)]);
};

export const subjectAddress = (subject: SubjectRef) =>
  `#/proof/${subject.kind}/${encodeURIComponent(
    subject.kind === "built" ? subject.id : subject.faceId
  )}`;
