import { describe, expect, it } from "vitest";
import { faceStanding } from "~/generate/script-extension/face-standing";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import {
  type AddedGlyph,
  EMPTY_WORKING_FACE,
  type WorkingFace,
} from "~/typeface/changes";
import type { Face } from "~/typeface/face";
import { EMPTY_OUTLINE } from "~/typeface/outline";
import {
  acceptRun,
  emptyProject,
  holdRun,
  type TypefaceProject,
} from "~/typeface/project";
import { fixtureFace } from "../../helpers/faces";
import { stamp } from "../../helpers/fixed";

const lato = fixtureFace("lato");
const face: Face = {
  description: lato.description,
  id: "lato-regular",
  index: 0,
  sourceId: "lato",
};

const added = (key: string, character: number): AddedGlyph => ({
  advance: 600,
  characters: [character],
  key,
  name: key,
  outline: EMPTY_OUTLINE,
  provenance: { origin: "manual" },
});

const planned = (character: number): AddedGlyph => {
  const glyph = plan.glyphs.find((entry) =>
    entry.characters.includes(character)
  );
  if (!glyph) {
    throw new Error("The plan has no glyph for the character.");
  }
  return added(glyph.name, character);
};

const workingWith = (glyphs: readonly AddedGlyph[]): WorkingFace => ({
  ...EMPTY_WORKING_FACE,
  added: glyphs,
  characters: new Map(
    glyphs.flatMap((glyph) =>
      glyph.characters.map((character): [number, string] => [
        character,
        glyph.key,
      ])
    )
  ),
});

const projectWith = (
  working: WorkingFace,
  layout = false
): TypefaceProject => ({
  ...emptyProject(),
  faces: [face],
  head: 1,
  revisions: [
    {
      changes: [
        ...working.added.map((glyph) => ({
          faceId: face.id,
          glyph,
          kind: "glyph-added" as const,
        })),
        ...(layout
          ? [
              {
                code: "",
                description: "Rules",
                faceId: face.id,
                kind: "features-added" as const,
              },
            ]
          : []),
      ],
      createdAt: "now",
      id: "revision",
      label: "Glyphs",
    },
  ],
});

const none = () => false;

describe("where a face stands with the plan", () => {
  it("lacks every planned character when the source font has none", () => {
    expect(
      faceStanding({
        face,
        inSource: none,
        plan,
        project: projectWith(EMPTY_WORKING_FACE),
      })
    ).toEqual({ held: 0, kind: "lacking" });
  });

  it("is in the face when planned glyphs came with layout rules", () => {
    const working = workingWith([planned(0x09_15), planned(0x09_24)]);
    expect(
      faceStanding({
        face,
        inSource: none,
        plan,
        project: projectWith(working, true),
      })
    ).toEqual({ held: 2, kind: "in-face" });
    expect(
      faceStanding({
        face,
        inSource: none,
        plan,
        project: projectWith(working),
      }).kind
    ).toBe("not-offered");
    expect(
      faceStanding({
        face,
        inSource: none,
        plan,
        project: projectWith(EMPTY_WORKING_FACE),
      }).kind
    ).toBe("lacking");
  });

  it("is not offered for a face whose source font has planned characters", () => {
    const standing = faceStanding({
      face,
      inSource: (character) => character === 0x09_15,
      plan,
      project: projectWith(EMPTY_WORKING_FACE),
    });
    expect(standing).toMatchObject({ held: 1, kind: "not-offered" });
    expect(standing.kind === "not-offered" && standing.reason).toContain(
      "already has 1 of the plan's 15 characters in its source font"
    );
  });

  it("is not offered for a pinned instance, and says why", () => {
    const standing = faceStanding({
      face: { ...face, pinned: { location: { wght: 700 }, styleName: "Bold" } },
      inSource: none,
      plan,
      project: projectWith(EMPTY_WORKING_FACE),
    });
    expect(standing.kind === "not-offered" && standing.reason).toContain(
      "offered for static faces only"
    );
  });

  it("is not offered while a planned character has a glyph added some other way", () => {
    const standing = faceStanding({
      face,
      inSource: none,
      plan,
      project: projectWith(workingWith([added("accepted-alone", 0x09_15)])),
    });
    expect(standing).toMatchObject({ held: 1, kind: "not-offered" });
    expect(standing.kind === "not-offered" && standing.reason).toContain(
      "1 character of the plan already has a glyph added"
    );
  });

  it("is in the face when only one planned character came with rules", () => {
    const project = projectWith(workingWith([planned(0x09_15)]), true);
    expect(faceStanding({ face, inSource: none, plan, project })).toEqual({
      held: 1,
      kind: "in-face",
    });
    const removed = {
      ...project,
      head: 2,
      revisions: [
        ...project.revisions,
        {
          changes: [
            {
              faceId: face.id,
              key: planned(0x09_15).key,
              kind: "glyph-removed" as const,
            },
          ],
          createdAt: "now",
          id: "remove",
          label: "Remove",
        },
      ],
    };
    expect(
      faceStanding({ face, inSource: none, plan, project: removed })
    ).toEqual({ held: 0, kind: "lacking" });
  });
});

describe("the revision that puts an extension in a face", () => {
  it("T1: refuses a planned character added under another name with rules", () => {
    const project = projectWith(
      workingWith([added("other-ka", 0x09_15)]),
      true
    );
    expect(faceStanding({ face, inSource: none, plan, project })).toEqual({
      held: 1,
      kind: "not-offered",
      reason: `1 character of the plan already has a glyph added to ${face.description.fullName} in this project, with Latin spacing and no layout rules. The extension would map them a second time. Undo the revisions that added them, then come back.`,
    });
  });

  it("T2: refuses a revision that adds an unplanned glyph alongside the plan", () => {
    const glyphs = plan.glyphs.map((glyph) => ({
      ...added(glyph.name, 0),
      characters: glyph.characters,
    }));
    const project = projectWith(
      workingWith([...glyphs, added("unplanned", 0x41)]),
      true
    );
    expect(faceStanding({ face, inSource: none, plan, project }).kind).toBe(
      "not-offered"
    );
  });

  it("T3: lacks the extension when a revision adds only unrelated glyphs and rules", () => {
    const project = projectWith(workingWith([added("unplanned", 0x41)]), true);
    expect(faceStanding({ face, inSource: none, plan, project })).toEqual({
      held: 0,
      kind: "lacking",
    });
  });

  it("T4: recognizes an extension revision that names no run", () => {
    const glyphs = plan.glyphs.map((glyph) => ({
      ...added(glyph.name, 0),
      characters: glyph.characters,
    }));
    const project = projectWith(workingWith(glyphs), true);
    expect(project.revisions[0]?.acceptsRun).toBeUndefined();
    expect(faceStanding({ face, inSource: none, plan, project })).toEqual({
      held: 15,
      kind: "in-face",
    });
  });

  it("T5: recognizes an accepted run that made only some planned glyphs", () => {
    const changes = projectWith(
      workingWith([planned(0x09_15)]),
      true
    ).revisions.flatMap((revision) => revision.changes);
    const held = holdRun(
      { ...emptyProject(), faces: [face] },
      {
        changes,
        faceId: face.id,
        glyphs: 1,
        modelOutput: "output",
        runId: "partial",
        script: plan.script,
      }
    );
    const project = acceptRun(held, "partial", stamp());
    expect(faceStanding({ face, inSource: none, plan, project })).toEqual({
      held: 1,
      kind: "in-face",
    });
  });

  it("T6: lacks the extension after its only glyph is removed", () => {
    const glyph = planned(0x09_15);
    const accepted = projectWith(workingWith([glyph]), true);
    const project = {
      ...accepted,
      head: 2,
      revisions: [
        ...accepted.revisions,
        {
          changes: [
            { faceId: face.id, key: glyph.key, kind: "glyph-removed" as const },
          ],
          createdAt: "now",
          id: "remove",
          label: "Remove",
        },
      ],
    };
    expect(faceStanding({ face, inSource: none, plan, project })).toEqual({
      held: 0,
      kind: "lacking",
    });
  });
});
