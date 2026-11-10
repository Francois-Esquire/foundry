/**
 * What the Proof place has on its desk: a font the Export place built, or a
 * face as the project has it now, built on demand. `proof-address.ts` names
 * which.
 */

import type { KeptScriptSample } from "~/export/shaping-samples";
import type { BuildRequest } from "~/packaging/building";
import type { FaceId } from "~/typeface/face";

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
