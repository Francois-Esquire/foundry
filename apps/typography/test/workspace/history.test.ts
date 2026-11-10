import { beforeEach, describe, expect, it } from "vitest";
import { addedGlyph, type Change, sourceGlyph } from "~/typeface/changes";
import { canRedo, canUndo, isModified } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import { TRIANGLE } from "../helpers/fixtures";
import {
  FIXED_TIME,
  fixtureFile,
  importOne,
  testWorkspace,
} from "../helpers/workspace";

const ALEF = 0x5_d0;
const PRIVATE_USE = 0xe0_00;

describe("history through the workspace", () => {
  let workspace: Workspace;
  let faceId: string;
  let glyphAlef: number;

  const widen = (advance: number): Change => ({
    advance,
    faceId,
    glyph: sourceGlyph(glyphAlef),
    kind: "advance-changed",
  });

  const addTriangle = (characters: readonly number[]): Change => ({
    faceId,
    glyph: {
      advance: 1000,
      characters,
      key: "tri",
      name: "triangle",
      outline: TRIANGLE,
      provenance: { origin: "manual" },
    },
    kind: "glyph-added",
  });

  beforeEach(async () => {
    workspace = testWorkspace();
    ({ faceId } = await importOne(workspace, fixtureFile("hebrew")));
    glyphAlef = workspace.openFace(faceId).glyphForCharacter(ALEF) ?? 0;
  });

  it("applies changes as a revision stamped by the injected clock and ids", () => {
    const outcome = workspace.apply("Widen alef", [widen(1500)]);
    const { project } = workspace.getState();
    expect(outcome.ok).toBe(true);
    expect(project.head).toBe(1);
    expect(project.revisions).toEqual([
      {
        changes: [widen(1500)],
        createdAt: FIXED_TIME,
        id: "id-1",
        label: "Widen alef",
      },
    ]);
  });

  it("shows the glyph as the project has it, through undo and redo", () => {
    const source = workspace.openFace(faceId).glyph(glyphAlef);
    workspace.apply("Widen alef", [widen(1500)]);
    workspace.apply("Redraw alef", [
      {
        faceId,
        glyph: sourceGlyph(glyphAlef),
        kind: "outline-replaced",
        outline: TRIANGLE,
      },
    ]);
    const working = () =>
      workspace.workingGlyph(faceId, sourceGlyph(glyphAlef));
    expect(working()).toEqual({ advance: 1500, outline: TRIANGLE });

    workspace.undo();
    expect(working()).toEqual({ advance: 1500, outline: source.outline });
    expect(canRedo(workspace.getState().project)).toBe(true);

    workspace.undo();
    expect(working()).toEqual(source);
    expect(isModified(workspace.getState().project, faceId)).toBe(false);

    workspace.undo();
    expect(canUndo(workspace.getState().project)).toBe(false);

    workspace.redo();
    workspace.redo();
    expect(working()).toEqual({ advance: 1500, outline: TRIANGLE });

    workspace.checkout(1);
    expect(working()).toEqual({ advance: 1500, outline: source.outline });
    expect(workspace.getState().notices).toEqual([]);
  });

  it("drops undone revisions when a new change is applied", () => {
    workspace.apply("Widen alef", [widen(1500)]);
    workspace.undo();
    workspace.apply("Narrow alef", [widen(900)]);
    const { project } = workspace.getState();
    expect(project.revisions.map((revision) => revision.label)).toEqual([
      "Narrow alef",
    ]);
    workspace.redo();
    expect(workspace.getState().project.head).toBe(1);
  });

  it("maps a character to an added glyph once one takes it over", () => {
    expect(workspace.glyphForCharacter(faceId, ALEF)).toEqual(
      sourceGlyph(glyphAlef)
    );
    expect(workspace.glyphForCharacter(faceId, PRIVATE_USE)).toBeUndefined();

    workspace.apply("Add a triangle", [addTriangle([ALEF, PRIVATE_USE])]);
    expect(workspace.glyphForCharacter(faceId, ALEF)).toEqual(
      addedGlyph("tri")
    );
    expect(workspace.glyphForCharacter(faceId, PRIVATE_USE)).toEqual(
      addedGlyph("tri")
    );
    expect(workspace.workingGlyph(faceId, addedGlyph("tri"))).toEqual({
      advance: 1000,
      outline: TRIANGLE,
    });

    workspace.undo();
    expect(workspace.glyphForCharacter(faceId, ALEF)).toEqual(
      sourceGlyph(glyphAlef)
    );
    expect(workspace.workingGlyph(faceId, addedGlyph("tri"))).toBeUndefined();
  });

  it("lists every glyph with its characters and whether it is edited", () => {
    const face = workspace.openFace(faceId);
    const before = workspace.glyphsOf(faceId);
    expect(before).toHaveLength(face.description.glyphCount);
    expect(before[glyphAlef]).toEqual({
      characters: [ALEF],
      edited: false,
      name: face.glyphName(glyphAlef),
      ref: sourceGlyph(glyphAlef),
    });
    expect(before.some((glyph) => glyph.edited)).toBe(false);
    expect(workspace.glyphsOf(faceId)).toBe(before);

    workspace.apply("Widen alef and add a triangle", [
      widen(1500),
      addTriangle([ALEF, PRIVATE_USE]),
    ]);
    const after = workspace.glyphsOf(faceId);
    expect(after).toHaveLength(face.description.glyphCount + 1);
    expect(after[glyphAlef]).toMatchObject({ characters: [], edited: true });
    expect(after.at(-1)).toEqual({
      characters: [ALEF, PRIVATE_USE],
      edited: true,
      name: "triangle",
      provenance: { origin: "manual" },
      ref: addedGlyph("tri"),
    });
    expect(after.filter((glyph) => glyph.edited)).toHaveLength(2);

    workspace.undo();
    expect(workspace.glyphsOf(faceId)).toEqual(before);
  });

  it("lists glyphs that no character reaches", () => {
    const unmapped = workspace
      .glyphsOf(faceId)
      .filter((glyph) => glyph.characters.length === 0);
    expect(unmapped.length).toBeGreaterThan(0);
  });

  it("puts an accepted candidate into the face and leaves a rejected one out", () => {
    const proposed = workspace.propose([
      {
        advance: 1000,
        characters: [PRIVATE_USE],
        faceId,
        id: "c1",
        name: "triangle",
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
      {
        advance: 900,
        characters: [],
        faceId,
        id: "c2",
        name: "spare",
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
    ]);
    expect(proposed.ok).toBe(true);
    expect(workspace.getState().project.head).toBe(0);

    expect(workspace.acceptCandidate("c1").ok).toBe(true);
    expect(workspace.rejectCandidate("c2").ok).toBe(true);
    const { project } = workspace.getState();
    expect(project.candidates.map((candidate) => candidate.status)).toEqual([
      "accepted",
      "rejected",
    ]);
    expect(project.revisions[0]).toMatchObject({
      createdAt: FIXED_TIME,
      label: "Accept triangle",
    });
    expect(workspace.glyphForCharacter(faceId, PRIVATE_USE)).toEqual(
      addedGlyph("c1")
    );
    expect(workspace.glyphsOf(faceId).at(-1)?.name).toBe("triangle");
  });
});
