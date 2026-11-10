import { describe, expect, it } from "vitest";
import { sourceGlyph } from "~/typeface/changes";
import { digestOf } from "~/typeface/project";
import { FONTS, fontBytes } from "../helpers/fixtures";
import { importOne, testWorkspace } from "../helpers/workspace";

describe("exportOriginal", () => {
  it("returns the identical bytes that were imported, even after edits", async () => {
    const workspace = testWorkspace();
    const bytes = fontBytes("hebrew");
    const pristine = bytes.slice();
    const { faceId, sourceId } = await importOne(workspace, {
      bytes,
      name: FONTS.hebrew,
    });
    workspace.apply("Widen a glyph", [
      { advance: 1200, faceId, glyph: sourceGlyph(5), kind: "advance-changed" },
    ]);
    const exported = workspace.exportOriginal(sourceId);
    if (!exported.ok) {
      throw new Error(exported.notice.message);
    }
    expect(exported.value.fileName).toBe(FONTS.hebrew);
    expect(exported.value.bytes).toBe(bytes);
    expect(exported.value.bytes).toEqual(pristine);
    expect(await digestOf(exported.value.bytes)).toBe(sourceId);
  });

  it("fails with a notice for a source font the project does not have", () => {
    const workspace = testWorkspace();
    const exported = workspace.exportOriginal("missing");
    expect(exported.ok).toBe(false);
    expect(workspace.getState().notices).toEqual([
      {
        id: "id-1",
        message: "This project has no source font missing.",
        tone: "error",
      },
    ]);
  });
});
