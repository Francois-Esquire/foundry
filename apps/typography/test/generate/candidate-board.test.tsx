/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { acceptCandidates, passedCandidates } from "~/generate/accepting";
import { CandidateBoard } from "~/generate/candidate-board";
import {
  acceptCandidate,
  candidateStatuses,
  rejectCandidate,
  type TypefaceProject,
  type Verdict,
} from "~/typeface/project";
import { WorkspaceProvider } from "~/workspace/react";
import { createWorkspace } from "~/workspace/workspace";
import { countingIds, fixedClock, stamp } from "../helpers/fixed";
import { codes, latoSession } from "./helpers/session";

afterEach(cleanup);

it("shows the passed candidates that acceptance then puts in the face", async () => {
  const { faceId, session, workspace: generated } = await latoSession();
  await session.run({
    characters: codes("éèñöüà"),
    faceId,
    kind: "characters",
    strategy: "procedural",
  });
  const [shown] = session.getState().runs;
  if (!shown) {
    throw new Error("Missing run");
  }
  const verdicts: Verdict[] = [
    "pass",
    "review",
    "fail",
    "pass",
    "pass",
    "pass",
  ];
  let project: TypefaceProject = {
    ...generated.getState().project,
    candidates: generated
      .getState()
      .project.candidates.map((candidate, index) => ({
        ...candidate,
        verdict: verdicts[index],
      })),
  };
  const ids = project.candidates.map(({ id }) => id);
  project = acceptCandidate(project, ids[4] ?? "", stamp());
  project = rejectCandidate(project, ids[5] ?? "");
  const workspace = createWorkspace({
    clock: fixedClock,
    newId: countingIds("board"),
    project,
    reader: harfBuzzReader,
  });
  render(
    <WorkspaceProvider workspace={workspace}>
      <CandidateBoard
        busy={false}
        runs={[shown]}
        session={session}
        shown={shown}
      />
    </WorkspaceProvider>
  );
  const button = screen.getByRole("button", {
    name: "Accept everything that passed (2)",
  });
  expect(button.hasAttribute("disabled")).toBe(false);
  const result = acceptCandidates(
    workspace,
    passedCandidates(workspace.getState().project)
      .filter(({ id }) => ids.includes(id))
      .map(({ id }) => id)
  );
  expect(result).toEqual({ accepted: 2 });
  expect(
    workspace
      .getState()
      .project.revisions.slice(project.head)
      .map(({ accepts }) => accepts)
  ).toEqual([ids[0], ids[3]]);
  expect([...candidateStatuses(workspace.getState().project).values()]).toEqual(
    ["accepted", "proposed", "proposed", "accepted", "accepted", "rejected"]
  );
});
