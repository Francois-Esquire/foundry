import { describe, expect, it } from "vitest";
import { type Change, sourceGlyph } from "~/typeface/changes";
import type { NewCandidate } from "~/typeface/project";
import {
  addSource,
  commit,
  emptyProject,
  ProjectError,
  pinInstance,
  propose,
  rejectCandidate,
  type SourceFont,
  undo,
} from "~/typeface/project";
import { removeSource, sourceUsage } from "~/typeface/removal";
import { stamp } from "../helpers/fixed";
import { describeFace, TRIANGLE } from "../helpers/fixtures";
import {
  countingReader,
  fixtureFile,
  importOne,
  testWorkspace,
} from "../helpers/workspace";

const source = (id: string): SourceFont => ({
  bytes: new Uint8Array([1, 2, 3]),
  fileName: `${id}.ttf`,
  id,
  importedAt: "2026-11-10T00:00:00.000Z",
});

const widen = (faceId: string, advance: number): Change => ({
  advance,
  faceId,
  glyph: sourceGlyph(4),
  kind: "advance-changed",
});

const candidate = (faceId: string, id: string): NewCandidate => ({
  advance: 1000,
  characters: [],
  faceId,
  id,
  name: id,
  outline: TRIANGLE,
  provenance: { origin: "manual" },
});

const twoSources = () => {
  const one = addSource(emptyProject(), source("aaaa"), [describeFace()]);
  const project = addSource(one, source("bbbb"), [
    describeFace({ familyName: "Other" }),
  ]);
  const [keep, drop] = project.faces.map((face) => face.id);
  if (!(keep && drop)) {
    throw new Error("fixture faces missing");
  }
  return { drop, keep, project };
};

describe("removeSource in the project", () => {
  it("removes an unused source font and its faces", () => {
    const { keep, project } = twoSources();
    const removed = removeSource(project, "bbbb");
    expect(removed.sources.map((existing) => existing.id)).toEqual(["aaaa"]);
    expect(removed.faces.map((face) => face.id)).toEqual([keep]);
    expect(project.sources).toHaveLength(2);
  });

  it("refuses while the faces have applied changes or proposed candidates", () => {
    const { drop, project } = twoSources();
    const edited = commit(project, {
      ...stamp(),
      changes: [widen(drop, 700), widen(drop, 800)],
      label: "Edit",
    });
    const busy = propose(edited, [candidate(drop, "c1")]);
    expect(sourceUsage(busy, "bbbb")).toEqual({
      appliedChanges: 2,
      proposedCandidates: 1,
      waitingRuns: 0,
    });
    expect(() => removeSource(busy, "bbbb")).toThrow(
      new ProjectError(
        "bbbb.ttf has 2 applied changes and 1 proposed candidate. Undo or settle them first, or remove the font together with that work."
      )
    );
    expect(sourceUsage(busy, "aaaa")).toEqual({
      appliedChanges: 0,
      proposedCandidates: 0,
      waitingRuns: 0,
    });
  });

  it("allows removal once the changes are undone and the candidates settled", () => {
    const { drop, keep, project } = twoSources();
    const edited = commit(project, {
      ...stamp(),
      changes: [widen(drop, 700)],
      label: "Edit dropped",
    });
    const settled = rejectCandidate(
      propose(undo(edited), [candidate(drop, "c1"), candidate(keep, "c2")]),
      "c1"
    );
    const removed = removeSource(settled, "bbbb");
    expect(removed.revisions).toEqual([]);
    expect(removed.head).toBe(0);
    expect(removed.candidates.map((existing) => existing.id)).toEqual(["c2"]);
  });

  it("drops the work with the font when forced, and keeps history consistent", () => {
    const { drop, keep, project } = twoSources();
    const steps = [
      { changes: [widen(keep, 500)], label: "Keep only" },
      { changes: [widen(drop, 600)], label: "Drop only" },
      { changes: [widen(keep, 700), widen(drop, 700)], label: "Mixed" },
      { changes: [widen(keep, 800)], label: "Keep again" },
      { changes: [widen(drop, 900)], label: "Undone drop" },
    ];
    const history = steps.reduce(
      (current, step) => commit(current, { ...stamp(), ...step }),
      project
    );
    const busy = propose(undo(undo(history)), [
      candidate(drop, "c1"),
      candidate(keep, "c2"),
    ]);
    expect(busy.head).toBe(3);

    const removed = removeSource(busy, "bbbb", { force: true });
    expect(
      removed.revisions.map((revision) => [
        revision.label,
        revision.changes.length,
      ])
    ).toEqual([
      ["Keep only", 1],
      ["Mixed", 1],
      ["Keep again", 1],
    ]);
    expect(removed.head).toBe(2);
    expect(removed.revisions[1]?.id).toBe(busy.revisions[2]?.id);
    expect(removed.revisions[0]).toBe(busy.revisions[0]);
    expect(removed.revisions.flatMap((revision) => revision.changes)).toEqual([
      widen(keep, 500),
      widen(keep, 700),
      widen(keep, 800),
    ]);
    expect(removed.candidates.map((existing) => existing.id)).toEqual(["c2"]);
  });

  it("removes pinned instances with their variable source", () => {
    const axis = {
      default: 400,
      max: 900,
      min: 100,
      name: "Weight",
      tag: "wght",
    };
    const base = addSource(emptyProject(), source("vvvv"), [
      describeFace({ axes: [axis] }),
    ]);
    const pinned = pinInstance(
      base,
      base.faces[0]?.id ?? "",
      { wght: 700 },
      "Bold"
    );
    const edited = commit(pinned.project, {
      ...stamp(),
      changes: [widen(pinned.face.id, 640)],
      label: "Edit the instance",
    });
    expect(sourceUsage(edited, "vvvv").appliedChanges).toBe(1);
    expect(removeSource(edited, "vvvv", { force: true })).toMatchObject({
      faces: [],
      head: 0,
      revisions: [],
      sources: [],
    });
  });
});

describe("removeSource through the workspace", () => {
  it("removes the font, closes its faces and moves the active face on", async () => {
    const { counts, reader } = countingReader();
    const workspace = testWorkspace(reader);
    const sofia = await importOne(workspace, fixtureFile("sofia"));
    const hebrew = await importOne(workspace, fixtureFile("hebrew"));
    const pinned = workspace.pinInstance(sofia.faceId, { wght: 700 }, "Bold");
    if (!pinned.ok) {
      throw new Error(pinned.notice.message);
    }
    workspace.setActiveFace(pinned.value.id);
    workspace.openFace(pinned.value.id).close();
    expect(counts).toEqual({ closed: 0, opened: 2 });

    expect(workspace.removeSource(sofia.sourceId).ok).toBe(true);
    const { activeFaceId, notices, project } = workspace.getState();
    expect(project.sources.map((existing) => existing.id)).toEqual([
      hebrew.sourceId,
    ]);
    expect(activeFaceId).toBe(hebrew.faceId);
    expect(notices).toEqual([]);
    expect(counts).toEqual({ closed: 1, opened: 2 });
    expect(() => workspace.openFace(sofia.faceId)).toThrow(ProjectError);

    workspace.removeSource(hebrew.sourceId);
    expect(workspace.getState().activeFaceId).toBeUndefined();
  });

  it("refuses with a notice while the font carries work, then removes it when forced", async () => {
    const workspace = testWorkspace();
    const kept = await importOne(workspace, fixtureFile("postscript"));
    const { faceId, sourceId } = await importOne(
      workspace,
      fixtureFile("hebrew")
    );
    workspace.apply("Widen", [widen(faceId, 1500), widen(kept.faceId, 650)]);
    workspace.propose([candidate(faceId, "c1")]);

    const refused = workspace.removeSource(sourceId);
    expect(refused.ok).toBe(false);
    expect(
      workspace.getState().notices.map((notice) => notice.message)
    ).toEqual([
      "DavidLibre-Regular.ttf has 1 applied change and 1 proposed candidate. Undo or settle them first, or remove the font together with that work.",
    ]);
    expect(workspace.getState().project.sources).toHaveLength(2);

    expect(workspace.removeSource(sourceId, { force: true }).ok).toBe(true);
    const { project } = workspace.getState();
    expect(project.sources).toHaveLength(1);
    expect(project.candidates).toEqual([]);
    expect(project.revisions[0]?.changes).toEqual([widen(kept.faceId, 650)]);
    expect(project.head).toBe(1);

    workspace.undo();
    workspace.redo();
    expect(workspace.workingGlyph(kept.faceId, sourceGlyph(4))?.advance).toBe(
      650
    );
  });

  it("opens a font afresh when it is imported again after removal", async () => {
    const { counts, reader } = countingReader();
    const workspace = testWorkspace(reader);
    const first = await importOne(workspace, fixtureFile("hebrew"));
    workspace.removeSource(first.sourceId);
    const again = await importOne(workspace, fixtureFile("hebrew"));
    expect(again.sourceId).toBe(first.sourceId);
    expect(
      workspace.openFace(again.faceId).glyphForCharacter(0x5_d0)
    ).toBeDefined();
    expect(counts).toEqual({ closed: 1, opened: 2 });
  });
});
