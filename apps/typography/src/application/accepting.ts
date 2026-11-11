/**
 * The accept command. A waiting run goes into its face whole, as one
 * revision. Candidates go in one at a time, each as its own revision.
 */
import { acceptCandidates } from "~/generate/accepting";
import { addExtension } from "~/generate/script-extension/adding";
import type { Change } from "~/typeface/changes";
import type { Accepted, AcceptRequest } from "./commands";
import { CHANGE_SET_FILE } from "./generating";
import type { OpenProject } from "./open-project";
import { Refusal } from "./refusal";

const acceptRun = async (
  open: OpenProject,
  runId: string
): Promise<Accepted> => {
  const { waitingRuns } = open.kept();
  const run = waitingRuns.find((waiting) => waiting.runId === runId);
  if (!run) {
    throw new Refusal(
      waitingRuns.length > 0
        ? `No run ${runId} is waiting. The waiting runs are: ${waitingRuns.map((waiting) => waiting.runId).join(", ")}.`
        : `No run ${runId} is waiting. This project has no waiting run.`
    );
  }
  const changes = JSON.parse(
    new TextDecoder().decode(
      await open.store.read({ artifactId: run.modelOutput }, CHANGE_SET_FILE)
    )
  ) as readonly Change[];
  const outcome = addExtension(open.workspace, run.script, changes);
  if (!outcome.ok) {
    throw new Refusal(outcome.notice.message);
  }
  open.keep({
    waitingRuns: waitingRuns.filter((waiting) => waiting.runId !== runId),
  });
  return {
    accepted: run.glyphs,
    revisions: open.workspace.getState().project.head,
  };
};

/** The candidates a request names, in the order the project holds them. */
const namedCandidates = (
  open: OpenProject,
  named: readonly string[] | "all" | "passed"
): readonly string[] => {
  if (typeof named !== "string") {
    return named;
  }
  const { verdicts } = open.kept();
  return open.workspace
    .getState()
    .project.candidates.filter(
      (candidate) =>
        candidate.status === "proposed" &&
        (named === "all" || verdicts[candidate.id] === "pass")
    )
    .map((candidate) => candidate.id);
};

export const accept = (
  open: OpenProject,
  request: AcceptRequest
): Promise<Accepted> => {
  if ("run" in request) {
    return acceptRun(open, request.run);
  }
  const acceptance = acceptCandidates(
    open.workspace,
    namedCandidates(open, request.candidates)
  );
  // Refused before anything went in, the command did nothing at all.
  if (acceptance.refused && acceptance.accepted === 0) {
    throw new Refusal(acceptance.refused.reason);
  }
  return Promise.resolve({
    ...acceptance,
    revisions: open.workspace.getState().project.head,
  });
};
