/** Accepting several candidates at once, for every place and command that does. */
import type { Workspace } from "./workspace";

export interface Acceptance {
  /** How many candidates went into their faces, each as its own revision. */
  readonly accepted: number;
  /** The first candidate the project refused, and why. Those after it were not tried. */
  readonly refused?: { readonly id: string; readonly reason: string };
}

/**
 * Accepts candidates in the order given and stops at the first the project
 * refuses, so a refusal is never buried under the ones that followed it.
 */
export const acceptCandidates = (
  workspace: Pick<Workspace, "acceptCandidate">,
  candidateIds: readonly string[]
): Acceptance => {
  let accepted = 0;
  for (const id of candidateIds) {
    const outcome = workspace.acceptCandidate(id);
    if (!outcome.ok) {
      return { accepted, refused: { id, reason: outcome.notice.message } };
    }
    accepted += 1;
  }
  return { accepted };
};
