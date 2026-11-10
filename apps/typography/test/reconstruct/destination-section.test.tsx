/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STANDARD_METRICS } from "~/reconstruct/core";
import { DestinationSection } from "~/reconstruct/destination-section";
import {
  DESTINATION_GONE,
  type LetterReading,
  type Proposal,
  type ReconstructSession,
  type ReconstructState,
} from "~/reconstruct/session";
import { WorkspaceProvider } from "~/workspace/react";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

afterEach(cleanup);

const GONE_FACE = "1c5c0b8fa268bf1f:0";

/** The section reads only the proposal once letters were proposed. */
const proposedTo = (faceId: string) => {
  const proposal: Proposal = {
    faceId,
    kept: new Set(),
    letters: [],
    metrics: STANDARD_METRICS,
    taken: 0,
  };
  const session = { reopen: vi.fn() } as unknown as ReconstructSession;
  return {
    session,
    state: { proposal } as unknown as ReconstructState,
  };
};

const renderSection = async (faceIdOf: (imported: string) => string) => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile("lato"));
  const { session, state } = proposedTo(faceIdOf(faceId));
  render(
    <WorkspaceProvider workspace={workspace}>
      <DestinationSection
        project={workspace.getState().project}
        reading={{} as LetterReading}
        session={session}
        state={state}
      />
    </WorkspaceProvider>
  );
  return session;
};

describe("the proposed letters of a reconstruction", () => {
  it("are offered for a decision while their face is in the project", async () => {
    await renderSection((imported) => imported);
    expect(screen.getByRole("list", { name: "Observed letters" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Lato Regular in the Studio" })
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("say that the face is gone and offer only a new destination, with no internal id", async () => {
    const session = await renderSection(() => GONE_FACE);
    expect(screen.getByRole("alert").textContent).toContain(DESTINATION_GONE);
    expect(document.body.textContent).not.toContain(GONE_FACE);
    expect(screen.queryByRole("list", { name: "Observed letters" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    const actions = screen.getAllByRole("button");
    expect(actions.map((action) => action.textContent?.trim())).toEqual([
      "Choose a destination again",
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "Choose a destination again" })
    );
    expect(session.reopen).toHaveBeenCalledOnce();
  });
});
