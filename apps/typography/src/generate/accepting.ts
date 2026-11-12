/** Accepting several candidates at once, for every place and command that does. */
import { candidatesWithStatus, type TypefaceProject } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";

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

/**
 * Selects every proposed candidate its run passed, in the order the project
 * holds them. `among` narrows that to the candidates named: the ones on the
 * Generate place's board. The verdict is read from the candidate, so it is
 * the same one whoever made the run and whenever the project was opened.
 */
export const passedCandidates = (
  project: TypefaceProject,
  among?: ReadonlySet<string>
) =>
  candidatesWithStatus(project, "proposed").filter(
    ({ id, verdict }) => verdict === "pass" && (among?.has(id) ?? true)
  );

export const acceptPassed = (
  workspace: Pick<Workspace, "acceptCandidate" | "getState">,
  among?: ReadonlySet<string>
): Acceptance =>
  acceptCandidates(
    workspace,
    passedCandidates(workspace.getState().project, among).map(({ id }) => id)
  );
