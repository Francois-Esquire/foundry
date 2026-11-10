import { describe, expect, it } from "vitest";
import { sourceGlyph } from "~/typeface/changes";
import { TRIANGLE } from "../helpers/fixtures";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

const added = (faceId: string, name: string, character: number) =>
  ({
    faceId,
    glyph: {
      advance: 1000,
      characters: [character],
      key: name,
      name,
      outline: TRIANGLE,
      provenance: { origin: "manual" },
    },
    kind: "glyph-added",
  }) as const;

describe("the working face", () => {
  it("stays the same object until the face's history moves", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("lato"));
    const before = workspace.workingFace(faceId);
    const glyphs = workspace.glyphsOf(faceId);
    workspace.renameProject("Renamed");
    expect(workspace.workingFace(faceId)).toBe(before);
    expect(workspace.glyphsOf(faceId)).toBe(glyphs);

    workspace.apply("Widen", [
      { advance: 900, faceId, glyph: sourceGlyph(5), kind: "advance-changed" },
    ]);
    const edited = workspace.workingFace(faceId);
    expect(edited).not.toBe(before);
    expect(edited.overrides.get(5)?.advance).toBe(900);
    workspace.undo();
    expect(workspace.workingFace(faceId)).toEqual(before);
    expect(workspace.workingFace(faceId)).toBe(workspace.workingFace(faceId));
    workspace.redo();
    expect(workspace.workingFace(faceId)).toBe(edited);
  });

  it("refuses an added glyph that takes a name the source font uses", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("postscript"));
    const taken = workspace
      .openFace(faceId)
      .glyphName(workspace.openFace(faceId).glyphForCharacter(0x41) ?? 0);
    const refused = workspace.apply("Add", [added(faceId, taken, 0xe0_00)]);
    expect(refused.ok).toBe(false);
    expect(workspace.getState().notices.at(-1)?.message).toContain(
      `already has a glyph named ${taken}`
    );
    expect(
      workspace.apply("Add", [added(faceId, "triangle", 0xe0_00)]).ok
    ).toBe(true);
  });

  it("refuses to accept a candidate whose name the source font uses", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("postscript"));
    const face = workspace.openFace(faceId);
    const taken = face.glyphName(face.glyphForCharacter(0x41) ?? 0);
    workspace.propose([
      {
        advance: 600,
        characters: [0x41],
        faceId,
        id: "c1",
        name: taken,
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
    ]);
    expect(workspace.acceptCandidate("c1").ok).toBe(false);
    expect(workspace.getState().project.candidates[0]?.status).toBe("proposed");
  });
});
