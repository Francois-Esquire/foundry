import { describe, expect, it } from "vitest";
import { sourceGlyph } from "~/typeface/changes";
import {
  acceptCandidate,
  addSource,
  candidateStatuses,
  checkout,
  commit,
  emptyProject,
  propose,
  redo,
  rejectCandidate,
  type TypefaceProject,
  undo,
} from "~/typeface/project";
import { removeSource } from "~/typeface/removal";
import { stamp } from "../helpers/fixed";
import { describeFace, TRIANGLE } from "../helpers/fixtures";

const proposed = () => {
  const project = addSource(
    emptyProject(),
    {
      bytes: new Uint8Array([1]),
      fileName: "font.ttf",
      id: "font",
      importedAt: stamp().at,
    },
    [describeFace()]
  );
  return propose(project, [
    {
      advance: 600,
      characters: [0xe0_00],
      faceId: "font:0",
      id: "candidate",
      name: "new",
      outline: TRIANGLE,
      provenance: { origin: "manual" },
    },
  ]);
};
const standing = (project: TypefaceProject) =>
  candidateStatuses(project).get(project.candidates[0]?.id ?? "");
const accept = (project: TypefaceProject) =>
  acceptCandidate(project, "candidate", stamp());
const edit = (project: TypefaceProject) =>
  commit(project, {
    ...stamp(),
    changes: [
      {
        advance: 700,
        faceId: "font:0",
        glyph: sourceGlyph(1),
        kind: "advance-changed",
      },
    ],
    label: "Widen",
  });

describe("C1: candidate standing", () => {
  it("follows accept, undo, redo and checkout", () => {
    const base = proposed();
    const accepted = accept(base);
    expect(standing(base)).toBe("proposed");
    expect(standing(accepted)).toBe("accepted");
    expect(standing(undo(accepted))).toBe("proposed");
    expect(standing(redo(undo(accepted)))).toBe("accepted");
    expect(standing(checkout(accepted, 0))).toBe("proposed");
    expect(standing(checkout(checkout(accepted, 0), 1))).toBe("accepted");
  });
  it("keeps rejection through unrelated commits, undo and redo", () => {
    const rejected = rejectCandidate(proposed(), "candidate");
    const edited = edit(rejected);
    expect(standing(rejected)).toBe("rejected");
    expect(standing(edited)).toBe("rejected");
    expect(standing(undo(edited))).toBe("rejected");
    expect(standing(redo(undo(edited)))).toBe("rejected");
  });
  it("forgets a rejection when redo accepts the candidate again", () => {
    const rejected = rejectCandidate(undo(accept(proposed())), "candidate");
    expect(standing(rejected)).toBe("rejected");
    const redone = redo(rejected);
    expect(standing(redone)).toBe("accepted");
    expect(standing(undo(redone))).toBe("proposed");
    expect(standing(rejected)).toBe("rejected");
  });
  it("leaves the candidate proposed when a commit discards its undone acceptance", () => {
    const branched = edit(undo(accept(proposed())));
    expect(standing(branched)).toBe("proposed");
    expect(branched.revisions).toHaveLength(1);
    expect(standing(accept(branched))).toBe("accepted");
  });
  it("refuses removal with proposed work and removes candidates only with their font", () => {
    const base = proposed();
    expect(() => removeSource(base, "font")).toThrow("proposed candidate");
    expect(removeSource(base, "font", { force: true }).candidates).toEqual([]);
    const accepted = accept(base);
    expect(removeSource(accepted, "font", { force: true }).candidates).toEqual(
      []
    );
    expect(standing(base)).toBe("proposed");
    expect(
      removeSource(rejectCandidate(base, "candidate"), "font").candidates
    ).toEqual([]);
  });
});
