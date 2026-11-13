/** @vitest-environment happy-dom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { passedCandidates } from "~/generate/accepting";
import { CandidateBoard } from "~/generate/candidate-board";
import { EvaluationPanel } from "~/generate/evaluation-panel";
import {
  acceptCandidate,
  candidateStatuses,
  rejectCandidate,
  type TypefaceProject,
  type Verdict,
} from "~/typeface/project";
import { acceptCandidates } from "~/workspace/accept-candidates";
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

it("draws the verdict from the candidate even when old evaluation data disagrees", async () => {
  const { faceId, session } = await latoSession();
  await session.run({
    characters: codes("é"),
    faceId,
    kind: "characters",
    strategy: "procedural",
  });
  const reviewed = session.getState().runs[0]?.candidates[0];
  if (!reviewed) {
    throw new Error("Missing candidate");
  }
  const evaluation = { ...reviewed.evaluation, verdict: "pass" as const };
  const { container } = render(
    <EvaluationPanel
      notCompared="Not compared."
      reviewed={{
        ...reviewed,
        candidate: { ...reviewed.candidate, verdict: "review" },
        evaluation,
      }}
    />
  );
  expect(
    container.querySelector("[data-verdict]")?.getAttribute("data-verdict")
  ).toBe("review");
  expect(screen.getByText("Needs review")).toBeDefined();
});

it("selects the same passed project candidates through acceptance, undo and redo", async () => {
  const { faceId, session, workspace } = await latoSession();
  await session.run({
    characters: codes("éè"),
    faceId,
    kind: "characters",
    strategy: "procedural",
  });
  const [run] = session.getState().runs;
  if (!run) {
    throw new Error("Missing run");
  }
  const passed = () =>
    passedCandidates(workspace.getState().project).map(({ id }) => id);
  const ids = passed();
  render(
    <WorkspaceProvider workspace={workspace}>
      <CandidateBoard busy={false} runs={[run]} session={session} shown={run} />
    </WorkspaceProvider>
  );
  const shownCount = (count: number) =>
    screen.getByRole("button", {
      name: `Accept everything that passed (${count})`,
    });
  expect(shownCount(ids.length).hasAttribute("disabled")).toBe(false);
  expect(ids.length).toBeGreaterThan(0);
  act(() => {
    session.acceptPassed(run.id);
  });
  expect(shownCount(0).hasAttribute("disabled")).toBe(true);
  expect(passed()).toEqual([]);
  act(() => {
    workspace.undo();
  });
  expect(shownCount(1).hasAttribute("disabled")).toBe(false);
  expect(passed()).toEqual([ids.at(-1)]);
  act(() => {
    workspace.redo();
  });
  expect(shownCount(0).hasAttribute("disabled")).toBe(true);
  expect(passed()).toEqual([]);
});
