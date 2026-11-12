/**
 * The accept command. A waiting run goes into its face whole, as one
 * revision. Candidates go in one at a time, each as its own revision.
 */
import { acceptPassed } from "~/generate/accepting";
import { Refusal } from "~/lib/refusal";
import { candidatesWithStatus, waitingRuns } from "~/typeface/project";
import { generationRunId } from "~/typeface/provenance";
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

/**
 * The proposed candidates a run id stands for: the ones whose provenance
 * names that generation, in the project's order. None when the id is a
 * waiting held run's, which is looked for first.
 */
const candidatesOfRun = (
  { project }: ReturnType<Workspace["getState"]>,
  run: string
): string[] =>
  waitingRuns(project).some(({ runId }) => runId === run)
    ? []
    : candidatesWithStatus(project, "proposed")
        .filter(({ provenance }) => generationRunId(provenance) === run)
        .map(({ id }) => id);

export const accept = (
  open: OpenProject,
  request: AcceptRequest
): Promise<Accepted> => {
  const { workspace } = open;
  const ofRun =
    "run" in request ? candidatesOfRun(workspace.getState(), request.run) : [];
  if ("run" in request && ofRun.length === 0) {
    // A held run, or an id that names nothing, which the project refuses.
    const run = workspace.acceptRun(request.run);
    if (!run.ok) {
      throw new Refusal(run.notice.message);
    }
    return Promise.resolve({
      accepted: run.value.glyphs,
      revisions: workspace.getState().project.head,
    });
  }
  const acceptance = acceptNamed(
    workspace,
    "run" in request ? ofRun : request.candidates
  );
  // Refused before anything went in, the command did nothing at all.
  if (acceptance.refused && acceptance.accepted === 0) {
    throw new Refusal(acceptance.refused.reason);
  }
  return Promise.resolve({
    ...acceptance,
    revisions: workspace.getState().project.head,
  });
};
