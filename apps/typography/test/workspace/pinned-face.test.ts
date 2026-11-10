import { beforeAll, describe, expect, it } from "vitest";
import type { Face } from "~/typeface/face";
import type { OpenFace } from "~/typeface/reading";
import type { Workspace } from "~/workspace/workspace";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

describe("the open face of a pinned instance", () => {
  let workspace: Workspace;
  let variable: OpenFace;
  let pinned: Face;
  let view: OpenFace;
  let glyphA: number;

  beforeAll(async () => {
    workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("sofia"));
    variable = workspace.openFace(faceId);
    const outcome = workspace.pinInstance(faceId, { wght: 900 }, "Black");
    if (!outcome.ok) {
      throw new Error(outcome.notice.message);
    }
    pinned = outcome.value;
    view = workspace.openFace(pinned.id);
    glyphA = variable.glyphForCharacter(0x41) ?? 0;
  });

  it("describes itself as a static face with the pinned style name", () => {
    expect(variable.description.axes.map((axis) => axis.tag)).toEqual(["wght"]);
    expect(view.description).toMatchObject({
      axes: [],
      familyName: "Sofia Sans",
      fullName: "Sofia Sans Black",
      instances: [],
      styleName: "Black",
    });
    expect(view.description.glyphCount).toBe(variable.description.glyphCount);
  });

  it("reads glyphs at the pinned location by default", () => {
    const atDefault = variable.glyph(glyphA);
    const atBlack = variable.glyph(glyphA, { wght: 900 });
    expect(atBlack.advance).not.toBe(atDefault.advance);
    expect(view.glyph(glyphA)).toEqual(atBlack);
    expect(view.glyph(glyphA, { wght: 400 })).toEqual(atDefault);
  });

  it("shapes at the pinned location by default", () => {
    expect(view.shape("AV")).toEqual(
      variable.shape("AV", { location: { wght: 900 } })
    );
    expect(view.shape("AV", { location: { wght: 400 } })).toEqual(
      variable.shape("AV")
    );
    expect(view.shape("AV").glyphs[0]?.xAdvance).not.toBe(
      variable.shape("AV").glyphs[0]?.xAdvance
    );
  });

  it("shares the character map of its variable face", () => {
    expect(view.glyphForCharacter(0x41)).toBe(glyphA);
    expect(view.charactersForGlyph(glyphA)).toEqual(
      variable.charactersForGlyph(glyphA)
    );
    expect(view.glyphName(glyphA)).toBe(variable.glyphName(glyphA));
    expect(view.characters()).toBe(variable.characters());
  });

  it("is the same view every time, and takes edits through the workspace", () => {
    expect(workspace.openFace(pinned.id)).toBe(view);
    expect(
      workspace.workingGlyph(pinned.id, { glyphId: glyphA, kind: "source" })
    ).toEqual(variable.glyph(glyphA, { wght: 900 }));
  });

  it("leaves the variable face open when closed", () => {
    view.close();
    expect(variable.glyph(glyphA, { wght: 900 })).toEqual(view.glyph(glyphA));
  });

  it("refuses to pin a static face, with a notice", async () => {
    const { faceId } = await importOne(workspace, fixtureFile("hebrew"));
    const outcome = workspace.pinInstance(faceId, { wght: 700 }, "Bold");
    expect(outcome.ok).toBe(false);
    expect(workspace.getState().notices.at(-1)?.message).toBe(
      "Only a variable face can be pinned to an instance."
    );
  });
});
