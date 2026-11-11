import { describe, expect, it } from "vitest";
import { coveredRuns } from "~/proof/covered-runs";
import {
  subjectAddress,
  subjectKey,
  subjectOfKey,
  subjectOfPath,
  textOfPath,
} from "~/proof/proof-address";
import {
  validatorArguments,
  validatorCommand,
} from "~/proof/validator-command";
import { rasterDifference } from "~/proof/visual-regression";
import { workingRequest } from "~/proof/working-build";
import { sourceGlyph } from "~/typeface/changes";
import { commit, pinInstance } from "~/typeface/project";
import { stamp } from "../helpers/fixed";
import { describeFace, TRIANGLE } from "../helpers/fixtures";
import { startProject } from "../packaging/helpers/projects";

describe("setting text in one font only", () => {
  const has = (codePoint: number) =>
    "abc".includes(String.fromCodePoint(codePoint));

  it("splits out the characters the font lacks and keeps what draws nothing", () => {
    expect(coveredRuns("ab xc‍y", has)).toEqual([
      { kind: "set", text: "ab " },
      { codePoint: 0x78, kind: "missing" },
      { kind: "set", text: "c‍" },
      { codePoint: 0x79, kind: "missing" },
    ]);
    expect(coveredRuns("", has)).toEqual([]);
  });

  it("draws the crossed box for a private use character the font lacks", () => {
    expect(coveredRuns("a\u{e000}", has)).toEqual([
      { kind: "set", text: "a" },
      { codePoint: 0xe0_00, kind: "missing" },
    ]);
  });
});

describe("naming what to prove in the address", () => {
  it("reads and writes both kinds of subject", () => {
    const built = { id: "b 1", kind: "built" } as const;
    const face = { faceId: "ab12:0@wght=700", kind: "face" } as const;
    expect(subjectAddress(built)).toBe("#/proof/built/b%201");
    expect(subjectAddress(face)).toBe("#/proof/face/ab12%3A0%40wght%3D700");
    expect(subjectOfPath(["built", "b 1"])).toEqual(built);
    expect(subjectOfPath(["face", face.faceId])).toEqual(face);
    expect(subjectOfKey(subjectKey(face))).toEqual(face);
    expect(subjectOfKey(subjectKey(built))).toEqual(built);
  });

  it("carries a text to set after the subject, and reads it back", () => {
    const face = { faceId: "ab12:0", kind: "face" } as const;
    const address = subjectAddress(face, " नमस्ते é/è ");
    expect(address).toBe(
      "#/proof/face/ab12%3A0/%E0%A4%A8%E0%A4%AE%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A5%87%20%C3%A9%2F%C3%A8"
    );
    expect(textOfPath(["face", "ab12:0", "नमस्ते é/è"])).toBe("नमस्ते é/è");
    expect(subjectAddress(face, "  ")).toBe(subjectAddress(face));
    expect(textOfPath(["face", "ab12:0"])).toBeUndefined();
    expect(textOfPath(["face", "ab12:0", " "])).toBeUndefined();
  });

  it("names nothing for any other address", () => {
    expect(subjectOfPath([])).toBeUndefined();
    expect(subjectOfPath(["built"])).toBeUndefined();
    expect(subjectOfPath(["glyph", "a"])).toBeUndefined();
  });
});

describe("the independent validator command", () => {
  it("is the documented command with the shaper, the characters and the text", () => {
    expect(
      validatorArguments({
        characters: [0x41, 0x09_15, 0x1_f6_00],
        fontPath: "/tmp/Atlas Sans.ttf",
        shape: "office",
      })
    ).toEqual([
      "run",
      "--no-project",
      "--with",
      "fonttools",
      "--with",
      "opentype-sanitizer",
      "--with",
      "uharfbuzz",
      "python",
      "-I",
      "scripts/validate-font.py",
      "/tmp/Atlas Sans.ttf",
      "--expect-chars",
      "U+0041,U+0915,U+1F600",
      "--shape",
      "office",
    ]);
  });

  it("quotes for a shell only what needs it, and leaves out what was not asked", () => {
    expect(
      validatorCommand({ fontPath: "~/Downloads/Atlas.ttf", shape: "it's क्ष" })
    ).toBe(
      "uv run --no-project --with fonttools --with opentype-sanitizer --with uharfbuzz python -I scripts/validate-font.py '~/Downloads/Atlas.ttf' --shape 'it'\\''s क्ष'"
    );
    expect(
      validatorCommand({ characters: [], fontPath: "a.ttf" }).endsWith(
        "scripts/validate-font.py a.ttf"
      )
    ).toBe(true);
  });
});

describe("the request for a working face", () => {
  const WEIGHT = {
    default: 400,
    max: 900,
    min: 100,
    name: "Weight",
    tag: "wght",
  };

  it("is the whole source with the face's applied changes and nothing renamed", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { faceId, project } = startProject(
      "Specimen.ttf",
      describeFace(),
      bytes
    );
    const edited = commit(project, {
      ...stamp(),
      changes: [
        {
          faceId,
          glyph: sourceGlyph(3),
          kind: "outline-replaced",
          outline: TRIANGLE,
        },
        {
          code: "feature liga { } liga;",
          description: "Empty",
          faceId,
          kind: "features-added",
        },
      ],
      label: "Redraw",
    });
    const request = workingRequest(edited, faceId);
    expect(request.source).toBe(bytes);
    expect(request.overrides.get(3)?.outline).toBe(TRIANGLE);
    expect(request).toMatchObject({
      added: [],
      faceIndex: 0,
      featureCode: ["feature liga { } liga;"],
      location: undefined,
      styleName: undefined,
    });
    expect(request.familyName).toBeUndefined();
    expect(request.subset).toBeUndefined();
  });

  it("builds a pinned instance at its own location and style", () => {
    const { faceId, project } = startProject(
      "Flex.ttf",
      describeFace({ axes: [WEIGHT] })
    );
    const pinned = pinInstance(project, faceId, { wght: 700 }, "Bold");
    expect(workingRequest(pinned.project, pinned.face.id)).toMatchObject({
      location: { wght: 700 },
      styleName: "Bold",
    });
  });
});

describe("comparing two outlines pixel by pixel", () => {
  it("finds nothing between an outline and itself", () => {
    const difference = rasterDifference(TRIANGLE, TRIANGLE, 0.1);
    expect(difference).toMatchObject({
      derivedOnly: 0,
      share: 0,
      sourceOnly: 0,
    });
    expect(difference?.inked).toBeGreaterThan(2000);
  });

  it("counts what only one of them draws", () => {
    const shifted = {
      contours: TRIANGLE.contours.map((contour) => ({
        segments: contour.segments.map((segment) => ({
          ...segment,
          to: { x: segment.to.x + 400, y: segment.to.y },
        })),
        start: { x: contour.start.x + 400, y: contour.start.y },
      })),
    };
    const difference = rasterDifference(TRIANGLE, shifted, 0.1);
    expect(difference?.sourceOnly).toBeGreaterThan(0);
    expect(difference?.sourceOnly).toBe(difference?.derivedOnly);
    expect(difference?.share).toBeGreaterThan(0.5);
    expect(difference?.share).toBeLessThan(1);
  });

  it("has nothing to compare when neither draws anything", () => {
    expect(
      rasterDifference({ contours: [] }, { contours: [] }, 0.1)
    ).toBeUndefined();
  });
});
