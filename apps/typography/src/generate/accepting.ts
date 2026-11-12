/** Accepting the candidates of a face that their run passed. */
import { candidatesWithStatus, type TypefaceProject } from "~/typeface/project";
import {
  type Acceptance,
  acceptCandidates,
} from "~/workspace/accept-candidates";
import type { Workspace } from "~/workspace/workspace";

/** Selects every proposed candidate its run passed, in project order, from the candidate's own verdict. */
export const passedCandidates = (project: TypefaceProject) =>
  candidatesWithStatus(project, "proposed").filter(
    ({ verdict }) => verdict === "pass"
  );

export const acceptPassed = (
  workspace: Pick<Workspace, "acceptCandidate" | "getState">
): Acceptance =>
  acceptCandidates(
    workspace,
    passedCandidates(workspace.getState().project).map(({ id }) => id)
  );
