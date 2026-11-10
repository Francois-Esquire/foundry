import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { masterGroups, weightOf } from "~/export/variable/masters";
import { faceStyleName } from "~/typeface/face";
import { pinInstance, type TypefaceProject } from "~/typeface/project";
import { describeFace, FONTS, fontBytes } from "../../helpers/fixtures";
import { importFace, startProject } from "../../packaging/helpers/projects";

const pinAt = (
  project: TypefaceProject,
  faceId: string,
  weight: number,
  styleName: string,
  others: Readonly<Record<string, number>> = {}
) =>
  pinInstance(project, faceId, { ...others, wght: weight }, styleName).project;

describe("which variable faces are offered a variable font", () => {
  const sofia = fontBytes("sofia");
  const imported = startProject(
    FONTS.sofia,
    harfBuzzReader.open(sofia).description,
    sofia
  );

  it("lists nothing for a variable face with no pinned instance", () => {
    expect(masterGroups(imported.project)).toEqual([]);
  });

  it("does not offer one for a single pinned instance, and says what is missing", () => {
    const project = pinAt(imported.project, imported.faceId, 300, "Light");
    const [group] = masterGroups(project);
    expect(group).toMatchObject({
      familyName: "Sofia Sans",
      key: imported.faceId,
      offered: false,
    });
    expect(group?.pinned.map(faceStyleName)).toEqual(["Light"]);
    expect(group?.reason).toBe(
      "Sofia Sans has one pinned instance, Light. A variable font needs at least two, pinned at different weights. Pin another in the Studio, or generate across weights in Generate."
    );
  });

  it("offers one for two pinned instances at different weights, lightest first", () => {
    const heavy = pinAt(imported.project, imported.faceId, 800, "ExtraBold");
    const project = pinAt(heavy, imported.faceId, 300, "Light");
    const [group, ...others] = masterGroups(project);
    expect(others).toEqual([]);
    expect(group?.offered).toBe(true);
    expect(group?.reason).toBeUndefined();
    expect(group?.pinned.map(faceStyleName)).toEqual(["Light", "ExtraBold"]);
    expect(group?.pinned.map(weightOf)).toEqual([300, 800]);
  });

  it("does not offer one for instances that differ on another axis only", () => {
    const devanagari = fontBytes("devanagari");
    const wide = startProject(
      FONTS.devanagari,
      harfBuzzReader.open(devanagari).description,
      devanagari
    );
    const first = pinAt(wide.project, wide.faceId, 400, "Regular", {
      wdth: 100,
    });
    const project = pinAt(first, wide.faceId, 400, "Condensed", { wdth: 75 });
    const [group] = masterGroups(project);
    expect(group?.offered).toBe(false);
    expect(group?.reason).toContain("2 pinned instances at one weight");
  });

  it("does not offer one for a variable face without a weight axis", () => {
    const width = {
      default: 100,
      max: 125,
      min: 75,
      name: "Width",
      tag: "wdth",
    };
    const narrow = startProject(
      "Width.ttf",
      describeFace({ axes: [width], familyName: "Width Only" })
    );
    const first = pinInstance(narrow.project, narrow.faceId, { wdth: 75 }, "A");
    const second = pinInstance(
      first.project,
      narrow.faceId,
      { wdth: 125 },
      "B"
    );
    const [group] = masterGroups(second.project);
    expect(group?.offered).toBe(false);
    expect(group?.reason).toContain("has no weight axis");
  });

  it("keeps each variable face's instances apart, and ignores static faces", () => {
    const lato = fontBytes("lato");
    const both = importFace(
      pinAt(
        pinAt(imported.project, imported.faceId, 300, "Light"),
        imported.faceId,
        800,
        "ExtraBold"
      ),
      FONTS.lato,
      harfBuzzReader.open(lato).description,
      lato
    );
    const arabic = fontBytes("arabic");
    const three = importFace(
      both.project,
      FONTS.arabic,
      harfBuzzReader.open(arabic).description,
      arabic
    );
    const project = pinAt(three.project, three.faceId, 700, "Bold");
    expect(
      masterGroups(project).map((group) => [
        group.familyName,
        group.offered,
        group.pinned.length,
      ])
    ).toEqual([
      ["Sofia Sans", true, 2],
      ["Noto Naskh Arabic", false, 1],
    ]);
  });
});
