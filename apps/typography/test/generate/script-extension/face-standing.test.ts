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
import { emptyProject, type TypefaceProject } from "~/typeface/project";
import { fixtureFace } from "../../helpers/faces";

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
    const working = workingWith([added("ka", 0x09_15), added("ta", 0x09_24)]);
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
    const project = projectWith(workingWith([added("ka", 0x09_15)]), true);
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
            { faceId: face.id, key: "ka", kind: "glyph-removed" as const },
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
