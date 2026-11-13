/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FamilyBoard } from "~/generate/family/family-board";
import { WorkspaceProvider } from "~/workspace/react";
import { sofiaSession } from "./helpers/family-session";

afterEach(cleanup);

it("shows the verdict carried only by the candidate", async () => {
  const { faceId, request, session, workspace } = await sofiaSession();
  await session.run(request());
  const [run] = session.getState().runs;
  const face = workspace
    .getState()
    .project.faces.find((known) => known.id === faceId);
  if (!(run && face)) {
    throw new Error("Missing family run or face.");
  }
  const shown = {
    ...run,
    characters: run.characters.map((character) => ({
      ...character,
      cells: character.cells.map(({ candidate, missing }) => ({
        candidate: candidate
          ? { ...candidate, verdict: "review" as const }
          : undefined,
        missing,
      })),
    })),
  };
  render(
    <WorkspaceProvider workspace={workspace}>
      <FamilyBoard face={face} runs={[shown]} session={session} shown={shown} />
    </WorkspaceProvider>
  );
  expect(screen.getAllByText("Evaluation: needs review.")).toHaveLength(18);
});
