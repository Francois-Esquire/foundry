import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  masterFactsOf,
  planVariableFont,
} from "~/export/variable/variable-plan";
import type { AddedGlyph } from "~/typeface/changes";
import { commit, pinInstance, type TypefaceProject } from "~/typeface/project";
import { stamp } from "../../helpers/fixed";
import { FONTS, fontBytes, TRIANGLE } from "../../helpers/fixtures";
import { addedWedge } from "../../packaging/helpers/masters";
import { startProject } from "../../packaging/helpers/projects";

const SQUARE = {
  contours: [
    {
      segments: [
        { kind: "line", to: { x: 100, y: 700 } },
        { kind: "line", to: { x: 800, y: 700 } },
        { kind: "line", to: { x: 800, y: 0 } },
      ],
      start: { x: 100, y: 0 },
    },
  ],
} as const;

describe("the plan of a variable font", () => {
  const sofia = fontBytes("sofia");
  const imported = startProject(
    FONTS.sofia,
    harfBuzzReader.open(sofia).description,
    sofia
  );
  const light = pinInstance(
    imported.project,
    imported.faceId,
    { wght: 300 },
    "Light"
  );
  const bold = pinInstance(
    light.project,
    imported.faceId,
    { wght: 700 },
    "Bold"
  );
  const masters = [bold.face.id, light.face.id];
  const adding = (
    project: TypefaceProject,
    faceId: string,
    glyph: AddedGlyph
  ) =>
    commit(project, {
      ...stamp(),
      changes: [{ faceId, glyph, kind: "glyph-added" }],
      label: `Add ${glyph.name}`,
    });
  const matched = adding(
    adding(bold.project, light.face.id, addedWedge(250)),
    bold.face.id,
    addedWedge(450)
  );

  it("plans the file, the masters lightest first and a request when nothing is wrong", () => {
    const plan = planVariableFont(matched, masters, {
      familyName: "Atlas Sans",
    });
    expect(plan.fileName).toBe("AtlasSans-VariableRebuilt.ttf");
    expect(plan.problems).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.masters).toEqual([
      {
        added: 1,
        faceId: light.face.id,
        overridden: 0,
        styleName: "Light",
        weight: 300,
      },
      {
        added: 1,
        faceId: bold.face.id,
        overridden: 0,
        styleName: "Bold",
        weight: 700,
      },
    ]);
    expect(plan.request?.masters).toHaveLength(2);
    expect(plan.request?.familyName).toBe("Atlas Sans");
  });

  it("warns that the source's own family name is kept, without blocking", () => {
    const plan = planVariableFont(matched, masters, { flavor: "woff2" });
    expect(plan.fileName).toBe("SofiaSans-VariableRebuilt.woff2");
    expect(plan.problems).toEqual([]);
    expect(plan.warnings).toEqual([
      "The rebuilt font keeps the family name Sofia Sans, so it can pass for the original. Give it a family name of its own.",
    ]);
    expect(plan.request).toBeDefined();
  });

  it("blocks a single master in packaging's own words", () => {
    const plan = planVariableFont(matched, [light.face.id], {
      familyName: "Atlas Sans",
    });
    expect(plan.problems).toEqual([
      "A variable font needs at least two masters. Pin another instance of the variable face.",
    ]);
    expect(plan.request).toBeUndefined();
    expect(plan.masters).toHaveLength(1);
  });

  it("blocks a master that lacks a glyph the others added, and names the way out", () => {
    const uneven = adding(bold.project, light.face.id, addedWedge(250));
    const plan = planVariableFont(uneven, masters, {
      familyName: "Atlas Sans",
    });
    expect(plan.problems).toEqual([
      "Bold lacks an added glyph the other masters have: wedge. Every master needs the same added glyphs. Accept it for Bold too, or leave Bold out of the masters.",
    ]);
    expect(plan.request).toBeUndefined();
  });

  it("blocks a glyph the masters draw differently, with the reason it cannot interpolate", () => {
    const redrawn = adding(
      adding(bold.project, light.face.id, addedWedge(250)),
      bold.face.id,
      addedWedge(450, { outline: SQUARE })
    );
    const plan = planVariableFont(redrawn, masters, {
      familyName: "Atlas Sans",
    });
    expect(plan.problems).toEqual([
      "The glyph wedge cannot interpolate. Contour 1 has 2 segments in Light and 3 in Bold. Redraw it so every master has the same contours and points, or remove it from the masters.",
    ]);
    expect(plan.request).toBeUndefined();
  });

  it("lists a few of many missing glyphs and counts the others", () => {
    let { project } = bold;
    for (let index = 0; index < 8; index += 1) {
      project = adding(project, light.face.id, {
        advance: 600,
        characters: [0xe1_00 + index],
        key: `extra-${index}`,
        name: `extra${index}`,
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      });
    }
    const [problem, ...others] = planVariableFont(project, masters, {
      familyName: "Atlas Sans",
    }).problems;
    expect(others).toEqual([]);
    expect(problem).toContain(
      "Bold lacks 8 added glyphs the other masters have: extra0, extra1, extra2, extra3, extra4, extra5 and 2 more."
    );
  });

  it("says what every pinned instance carries, chosen as a master or not", () => {
    expect(
      masterFactsOf(matched, [light.face, bold.face]).map((facts) => [
        facts.styleName,
        facts.weight,
        facts.added,
      ])
    ).toEqual([
      ["Light", 300, 1],
      ["Bold", 700, 1],
    ]);
  });
});
