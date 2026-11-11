/** Pinning instances and proposing candidates for them is one change to the project, or none. */
import { beforeEach, describe, expect, it } from "vitest";
import type { NewCandidate } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import { TRIANGLE } from "../helpers/fixtures";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

const LIGHT = { location: { wght: 300 }, styleName: "Light" };
const BLACK = { location: { wght: 900 }, styleName: "Black" };

describe("pinning instances and proposing for them", () => {
  let workspace: Workspace;
  let faceId: string;

  const candidate = (id: string, weight: number): NewCandidate => ({
    advance: 600,
    characters: [0x01_09],
    faceId: `${faceId}@wght=${weight}`,
    id,
    name: "ccircumflex",
    outline: TRIANGLE,
    provenance: { origin: "manual" },
  });

  beforeEach(async () => {
    workspace = testWorkspace();
    ({ faceId } = await importOne(workspace, fixtureFile("sofia")));
  });

  it("pins every instance and proposes every candidate, and says so once", () => {
    let heard = 0;
    workspace.subscribe(() => {
      heard += 1;
    });
    const outcome = workspace.pinAndPropose(
      faceId,
      [LIGHT, BLACK],
      [candidate("c1", 300), candidate("c2", 900)]
    );
    expect(outcome.ok).toBe(true);
    const { project } = workspace.getState();
    expect(
      project.faces.flatMap((face) => (face.pinned ? [face.pinned] : []))
    ).toEqual([LIGHT, BLACK]);
    expect(
      project.candidates.map(({ faceId: at, id, status }) => [at, id, status])
    ).toEqual([
      [`${faceId}@wght=300`, "c1", "proposed"],
      [`${faceId}@wght=900`, "c2", "proposed"],
    ]);
    // An instance is not a revision: nothing was applied to any face.
    expect(project.head).toBe(0);
    expect(heard).toBe(1);
  });

  it("pins nothing when a candidate is refused, and leaves the project as it was", () => {
    const before = workspace.getState().project;
    const outcome = workspace.pinAndPropose(
      faceId,
      [LIGHT, BLACK],
      [candidate("c1", 300), candidate("c1", 900)]
    );
    expect(outcome.ok).toBe(false);
    expect(workspace.getState().project).toBe(before);
    expect(
      workspace.getState().notices.map((notice) => notice.message)
    ).toEqual(["Candidate c1 was already proposed."]);
  });

  it("proposes nothing when an instance cannot be pinned", () => {
    const pinned = workspace.pinInstance(faceId, LIGHT.location, "Light");
    const before = workspace.getState().project;
    // A pinned instance has no axes left to pin.
    const outcome = workspace.pinAndPropose(
      pinned.ok ? pinned.value.id : "",
      [BLACK],
      [candidate("c1", 300)]
    );
    expect(outcome.ok).toBe(false);
    expect(workspace.getState().project).toBe(before);
  });
});
