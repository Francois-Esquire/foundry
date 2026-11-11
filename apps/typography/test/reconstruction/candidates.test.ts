import { describe, expect, it } from "vitest";
import { rectangleRegion } from "~/reconstruction/evidence/region";
import { observedFace } from "~/reconstruction/inference/observed-face";
import { isolateLettering } from "~/reconstruction/isolation/isolate";
import {
  LabelCountError,
  labelFromText,
  type Recognizer,
  readLettering,
  relabel,
} from "~/reconstruction/recognition/recognizer";
import { reconstruct } from "~/reconstruction/reconstruct";
import { namingFor } from "~/reconstruction/recovery/naming";
import { DEFAULT_METRICS } from "~/reconstruction/recovery/recover";
import { sourceGlyph } from "~/typeface/changes";
import {
  acceptCandidate,
  addSource,
  emptyProject,
  propose,
  workingFaceOf,
} from "~/typeface/project";
import { fixtureFace } from "../helpers/faces";
import { stamp } from "../helpers/fixed";
import { TRIANGLE } from "../helpers/fixtures";
import {
  plainPicture,
  setLettering,
  syntheticEvidence,
} from "./helpers/lettering";

const A = 0x41;
const lato = fixtureFace("lato");
const picture = plainPicture(
  setLettering([{ emSize: 140, face: lato, text: "HAND" }]).ink
);
const evidence = syntheticEvidence(picture, "hand");
const region = rectangleRegion(0, 0, picture.width, picture.height);

describe("naming reconstructed glyphs", () => {
  it("uses the conventional name when nothing is known about the target face", () => {
    expect(namingFor({ faceId: "target" })(A)).toEqual({
      name: "uni0041",
      replaces: undefined,
    });
  });

  it("redraws a glyph the target face already has", () => {
    const glyphId = lato.glyphForCharacter(A) ?? -1;
    expect(namingFor({ face: lato, faceId: "target" })(A)).toEqual({
      name: "uni0041",
      replaces: sourceGlyph(glyphId),
    });
  });

  it("steps aside from a name a source glyph holds", () => {
    // A face whose own glyph for A is already called uni0041.
    const taken = observedFace(
      [{ advance: 600, character: A, outline: TRIANGLE }],
      DEFAULT_METRICS
    );
    expect(taken.glyphName(1)).toBe("uni0041");
    expect(namingFor({ face: taken, faceId: "target" })(A)).toEqual({
      name: "uni0041.reconstructed",
      replaces: sourceGlyph(1),
    });
    expect(namingFor({ face: taken, faceId: "target" })(0x42)).toEqual({
      name: "uni0042",
      replaces: undefined,
    });
  });
});

describe("candidates for a face that has the letters already", () => {
  it("are accepted as redrawings that carry their provenance", () => {
    const source = {
      bytes: new Uint8Array([1]),
      fileName: "Lato-Regular.ttf",
      id: "lato-source",
      importedAt: "2026-11-10T00:00:00.000Z",
    };
    const project = addSource(emptyProject(), source, [lato.description]);
    const faceId = project.faces[0]?.id ?? "";
    const { distinct } = reconstruct({
      evidence,
      region,
      target: { face: lato, faceId },
      text: ["HAND"],
    });
    expect(distinct).toHaveLength(4);
    const glyphNames = new Set(
      Array.from({ length: lato.description.glyphCount }, (_, glyphId) =>
        lato.glyphName(glyphId)
      )
    );
    for (const { candidate, character } of distinct) {
      expect(candidate.replaces).toEqual(
        sourceGlyph(lato.glyphForCharacter(character) ?? -1)
      );
      expect(glyphNames.has(candidate.name)).toBe(false);
    }
    const letterA = distinct.find((letter) => letter.character === A);
    const accepted = acceptCandidate(
      propose(
        project,
        distinct.map((letter) => letter.candidate)
      ),
      letterA?.candidate.id ?? "",
      stamp()
    );
    const override = workingFaceOf(accepted, faceId).overrides.get(
      lato.glyphForCharacter(A) ?? -1
    );
    expect(override?.outline).toEqual(letterA?.candidate.outline);
    expect(override?.provenance).toMatchObject({
      basis: "observed",
      evidenceId: evidence.id,
      origin: "reconstructed",
    });
    expect(override?.advance).toBe(letterA?.candidate.advance);
  });
});

describe("labels", () => {
  const { lines } = isolateLettering(picture);
  /** Any recogniser can stand behind the port. This one calls everything a question mark. */
  const unsure: Recognizer = {
    id: "unsure",
    recognise: (line) =>
      line.letters.map(() => [{ character: 0x3f, confidence: 0.1 }]),
  };
  const readings = readLettering(lines, unsure);

  it("start as the recogniser's best guess", () => {
    expect(readings.map((reading) => reading.character)).toEqual([
      0x3f, 0x3f, 0x3f, 0x3f,
    ]);
    expect(
      readings.every((reading) => reading.labelledBy === "recognizer")
    ).toBe(true);
  });

  it("can always be overridden by a person, one letter or a line at a time", () => {
    const [first] = readings;
    expect(first && relabel(first, A)).toMatchObject({
      character: A,
      guesses: [{ character: 0x3f }],
      labelledBy: "person",
    });
    const typed = labelFromText(readings, ["H A N D"]);
    expect(
      typed.map((reading) => String.fromCodePoint(reading.character ?? 0))
    ).toEqual(["H", "A", "N", "D"]);
  });

  it("are refused from typed text of the wrong length, with the way out", () => {
    expect(() => labelFromText(readings, ["HAN"])).toThrow(LabelCountError);
    expect(() => labelFromText(readings, ["HAN"])).toThrow(
      "Line 1 has 4 letters and the text given for it has 3. Label the letters one by one instead."
    );
  });

  it("leave a letter untraced when nobody and nothing says what it is", () => {
    const { recovered, readings: unread } = reconstruct({
      evidence,
      region,
      target: { faceId: "target" },
    });
    expect(unread).toHaveLength(4);
    expect(unread.every((reading) => reading.character === undefined)).toBe(
      true
    );
    expect(recovered).toEqual([]);
  });
});
