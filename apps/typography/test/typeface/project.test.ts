import { describe, expect, it } from "vitest";
import { addedGlyph, sourceGlyph } from "~/typeface/changes";
import { isEditable } from "~/typeface/face";
import {
  acceptCandidate,
  addSource,
  type Candidate,
  canRedo,
  commit,
  emptyProject,
  families,
  ProjectError,
  pinInstance,
  propose,
  redo,
  rejectCandidate,
  type SourceFont,
  type TypefaceProject,
  undo,
  workingFaceOf,
} from "~/typeface/project";
import { describeFace, TRIANGLE } from "../helpers/fixtures";

const source = (id: string): SourceFont => ({
  bytes: new Uint8Array([1, 2, 3]),
  fileName: `${id}.ttf`,
  id,
  importedAt: "2026-11-09T00:00:00.000Z",
});

const WGHT = { default: 400, max: 900, min: 100, name: "Weight", tag: "wght" };

const projectWithFaces = () => {
  const withStatic = addSource(emptyProject(), source("aaaa"), [
    describeFace(),
  ]);
  const project = addSource(withStatic, source("bbbb"), [
    describeFace({ axes: [WGHT], familyName: "Flex" }),
  ]);
  const [staticFace, variableFace] = project.faces;
  if (!(staticFace && variableFace)) {
    throw new Error("fixture faces missing");
  }
  return { project, staticFace, variableFace };
};

const candidate = (faceId: string, id = "c1"): Omit<Candidate, "status"> => ({
  advance: 1000,
  characters: [0x09_15],
  faceId,
  id,
  name: "ka-deva",
  outline: TRIANGLE,
  provenance: {
    createdAt: "2026-11-09T00:00:00.000Z",
    origin: "generated",
    runId: "run-1",
    strategy: "procedural",
  },
});

describe("sources and faces", () => {
  it("imports the same file only once", () => {
    const { project } = projectWithFaces();
    expect(addSource(project, source("aaaa"), [describeFace()])).toBe(project);
    expect(project.sources).toHaveLength(2);
  });

  it("groups faces into families, lightest first", () => {
    const base = addSource(emptyProject(), source("aaaa"), [
      describeFace({ styleName: "Bold", weightClass: 700 }),
      describeFace({ italic: true, styleName: "Italic" }),
      describeFace(),
    ]);
    const [family] = families(base);
    expect(family?.faces.map((face) => face.description.styleName)).toEqual([
      "Regular",
      "Italic",
      "Bold",
    ]);
  });

  it("pins a variable face to an editable instance, clamped to its axes", () => {
    const { project, variableFace } = projectWithFaces();
    expect(isEditable(variableFace)).toBe(false);
    const pinned = pinInstance(
      project,
      variableFace.id,
      { wght: 1200 },
      "Black"
    );
    expect(pinned.face.pinned).toEqual({
      location: { wght: 900 },
      styleName: "Black",
    });
    expect(isEditable(pinned.face)).toBe(true);
    expect(
      pinInstance(pinned.project, variableFace.id, { wght: 900 }, "Black")
        .project
    ).toBe(pinned.project);
  });

  it("refuses to pin a static face", () => {
    const { project, staticFace } = projectWithFaces();
    expect(() => pinInstance(project, staticFace.id, {}, "Regular")).toThrow(
      ProjectError
    );
  });
});

describe("revisions", () => {
  const edited = (project: TypefaceProject, faceId: string) =>
    commit(project, {
      changes: [
        {
          advance: 640,
          faceId,
          glyph: sourceGlyph(5),
          kind: "advance-changed",
        },
      ],
      label: "Widen a",
    });

  it("folds applied changes into the working face and leaves the source alone", () => {
    const { project, staticFace } = projectWithFaces();
    const next = edited(project, staticFace.id);
    expect(workingFaceOf(next, staticFace.id).overrides.get(5)).toEqual({
      advance: 640,
    });
    expect(next.sources).toBe(project.sources);
    expect(workingFaceOf(project, staticFace.id).overrides.size).toBe(0);
  });

  it("undoes and redoes, and drops undone revisions on a new commit", () => {
    const { project, staticFace } = projectWithFaces();
    const undone = undo(edited(project, staticFace.id));
    expect(workingFaceOf(undone, staticFace.id).overrides.size).toBe(0);
    expect(canRedo(undone)).toBe(true);
    expect(
      workingFaceOf(redo(undone), staticFace.id).overrides.get(5)?.advance
    ).toBe(640);
    const branched = commit(undone, {
      changes: [
        {
          advance: 500,
          faceId: staticFace.id,
          glyph: sourceGlyph(5),
          kind: "advance-changed",
        },
      ],
      label: "Narrow a",
    });
    expect(branched.revisions.map((revision) => revision.label)).toEqual([
      "Narrow a",
    ]);
    expect(canRedo(branched)).toBe(false);
  });

  it("rejects changes the face cannot take", () => {
    const { project, staticFace, variableFace } = projectWithFaces();
    const change = (faceId: string, glyphId: number, advance: number) => () =>
      commit(project, {
        changes: [
          {
            advance,
            faceId,
            glyph: sourceGlyph(glyphId),
            kind: "advance-changed",
          },
        ],
        label: "Bad",
      });
    expect(change(variableFace.id, 5, 600)).toThrow("Pin an instance");
    expect(change(staticFace.id, 100, 600)).toThrow("no glyph 100");
    expect(change(staticFace.id, 5, -1)).toThrow("zero or more");
    expect(change("missing", 5, 600)).toThrow("no face");
  });

  it("checks each change against the ones before it in the same commit", () => {
    const { project, staticFace } = projectWithFaces();
    const glyph = {
      advance: 1000,
      characters: [0xe0_00],
      key: "k1",
      name: "tri",
      outline: TRIANGLE,
      provenance: { origin: "manual" } as const,
    };
    const next = commit(project, {
      changes: [
        { faceId: staticFace.id, glyph, kind: "glyph-added" },
        {
          advance: 1100,
          faceId: staticFace.id,
          glyph: addedGlyph("k1"),
          kind: "advance-changed",
        },
      ],
      label: "Add and widen",
    });
    const working = workingFaceOf(next, staticFace.id);
    expect(working.added).toMatchObject([{ advance: 1100, key: "k1" }]);
    expect(working.characters.get(0xe0_00)).toBe("k1");
    expect(() =>
      commit(next, {
        changes: [{ faceId: staticFace.id, glyph, kind: "glyph-added" }],
        label: "Again",
      })
    ).toThrow("already has an added glyph");
  });
});

describe("candidates", () => {
  it("stay out of the face until accepted", () => {
    const { project, staticFace } = projectWithFaces();
    const proposed = propose(project, [candidate(staticFace.id)]);
    expect(workingFaceOf(proposed, staticFace.id).added).toHaveLength(0);
    const accepted = acceptCandidate(proposed, "c1");
    expect(accepted.candidates[0]?.status).toBe("accepted");
    expect(workingFaceOf(accepted, staticFace.id).added[0]).toMatchObject({
      name: "ka-deva",
      provenance: { origin: "generated", strategy: "procedural" },
    });
    expect(() => acceptCandidate(accepted, "c1")).toThrow("already accepted");
  });

  it("can be rejected, and a redraw replaces the glyph it names", () => {
    const { project, staticFace } = projectWithFaces();
    const proposed = propose(project, [
      candidate(staticFace.id),
      { ...candidate(staticFace.id, "c2"), replaces: sourceGlyph(7) },
    ]);
    const rejected = rejectCandidate(proposed, "c1");
    expect(rejected.candidates[0]?.status).toBe("rejected");
    const accepted = acceptCandidate(rejected, "c2");
    expect(workingFaceOf(accepted, staticFace.id).overrides.get(7)).toEqual({
      advance: 1000,
      outline: TRIANGLE,
    });
    expect(workingFaceOf(accepted, staticFace.id).added).toHaveLength(0);
  });
});
