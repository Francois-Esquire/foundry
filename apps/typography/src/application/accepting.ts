/**
 * The accept command. A waiting run goes into its face whole, as one
 * revision. Candidates go in one at a time, each as its own revision.
 */
import { acceptPassed } from "~/generate/accepting";
import { Refusal } from "~/lib/refusal";
import { candidatesWithStatus } from "~/typeface/project";
import {
  type Acceptance,
  acceptCandidates,
} from "~/workspace/accept-candidates";
import type { Workspace } from "~/workspace/workspace";
import type { Accepted, AcceptRequest } from "./commands";
import type { OpenProject } from "./open-project";

/** Accepts the candidates a request names: some by id, every waiting one, or the ones that passed. */
const acceptNamed = (
  workspace: Workspace,
  named: readonly string[] | "all" | "passed"
): Acceptance => {
  if (named === "passed") {
    return acceptPassed(workspace);
  }
  return acceptCandidates(
    workspace,
    named === "all"
      ? candidatesWithStatus(workspace.getState().project, "proposed").map(
          ({ id }) => id
        )
      : named
  );
};

export const accept = (
  open: OpenProject,
  request: AcceptRequest
): Promise<Accepted> => {
  const { workspace } = open;
  if ("run" in request) {
    const run = workspace.acceptRun(request.run);
    if (!run.ok) {
      throw new Refusal(run.notice.message);
    }
    return Promise.resolve({
      accepted: run.value.glyphs,
      revisions: workspace.getState().project.head,
    });
  }
  const acceptance = acceptNamed(workspace, request.candidates);
  // Refused before anything went in, the command did nothing at all.
  if (acceptance.refused && acceptance.accepted === 0) {
    throw new Refusal(acceptance.refused.reason);
  }
  return Promise.resolve({
    ...acceptance,
    revisions: workspace.getState().project.head,
  });
};
