import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  type Change,
  EMPTY_WORKING_FACE,
  foldChanges,
  sourceGlyph,
} from "~/typeface/changes";
import {
  type Candidate,
  type CandidateStatus,
  candidatesWithStatus,
  emptyProject,
} from "~/typeface/project";
import type { OpenFace } from "~/typeface/reading";
import { scriptOf } from "~/unicode/characters";
import {
  type CharacterCoverage,
  type CharacterStatus,
  classifyFace,
  coverageByScript,
  coverageOf,
  type FaceCharacters,
} from "~/unicode/coverage";
import { charactersIn, scopeOf } from "~/unicode/scope";
import { findScript } from "~/unicode/scripts";
import { fontBytes, TRIANGLE } from "../helpers/fixtures";

const FACE_ID = "face";
const KA = 0x9_15;
const KHA = 0x9_16;
const GA = 0x9_17;
const LATIN = { code: "Latn", kind: "script" } as const;
const DEVANAGARI = { code: "Deva", kind: "script" } as const;

const sourceOnly = (face: OpenFace): FaceCharacters => ({
  candidates: [],
  glyphForCharacter: (codePoint) => face.glyphForCharacter(codePoint),
  source: face.characters(),
  working: EMPTY_WORKING_FACE,
});

const countIn = (face: OpenFace, script: string) =>
  face.characters().filter((codePoint) => scriptOf(codePoint) === script)
    .length;

describe("coverage of the fixture fonts", () => {
  let lato: OpenFace;
  let sofia: OpenFace;
  let devanagari: OpenFace;

  beforeAll(() => {
    lato = harfBuzzReader.open(fontBytes("lato"));
    sofia = harfBuzzReader.open(fontBytes("sofia"));
    devanagari = harfBuzzReader.open(fontBytes("devanagari"));
  });

  afterAll(() => {
    lato.close();
    sofia.close();
    devanagari.close();
  });

  it("counts a Latin face's Latin characters against the whole script", () => {
    const coverage = coverageOf(LATIN, classifyFace(sourceOnly(lato)).classify);
    const total = findScript("Latn")?.characterCount ?? 0;
    const inSource = countIn(lato, "Latn");
    expect(inSource).toBeGreaterThan(400);
    expect(coverage.total).toBe(total);
    expect(coverage.characters).toHaveLength(total);
    expect(coverage.counts).toEqual({
      added: 0,
      candidate: 0,
      edited: 0,
      missing: total - inSource,
      source: inSource,
    });
    expect(coverage.covered).toBe(inSource);
    expect(coverage.percent).toBeCloseTo((inSource / total) * 100, 10);
  });

  it("lists characters in order with their status", () => {
    const coverage = coverageOf(
      { kind: "block", name: "Basic Latin" },
      classifyFace(sourceOnly(lato)).classify
    );
    expect(coverage.total).toBe(128);
    expect(coverage.characters.map((entry) => entry.codePoint)).toEqual(
      Array.from({ length: 128 }, (_, index) => index)
    );
    const statusOf = (codePoint: number) =>
      coverage.characters[codePoint]?.status;
    expect(statusOf(0x41)).toBe("source");
    expect(statusOf(0x7a)).toBe("source");
    expect(statusOf(0x1)).toBe("missing");
    // Every printable ASCII character, space to tilde.
    expect(coverage.counts.source).toBeGreaterThanOrEqual(95);
    expect(coverage.counts.source + coverage.counts.missing).toBe(128);
  });

  it("finds nothing of a script the face does not have", () => {
    const coverage = coverageOf(
      DEVANAGARI,
      classifyFace(sourceOnly(lato)).classify
    );
    expect(coverage.total).toBe(164);
    expect(coverage.counts.missing).toBe(164);
    expect(coverage.covered).toBe(0);
    expect(coverage.percent).toBe(0);
  });

  it("covers Latin, Greek and Cyrillic in Sofia Sans", () => {
    const { classify } = classifyFace(sourceOnly(sofia));
    for (const code of ["Latn", "Grek", "Cyrl"]) {
      const coverage = coverageOf({ code, kind: "script" }, classify);
      expect(coverage.counts.source).toBe(countIn(sofia, code));
      expect(coverage.counts.source).toBeGreaterThan(50);
      expect(coverage.percent).toBeGreaterThan(0);
      expect(coverage.percent).toBeLessThanOrEqual(100);
    }
  });

  it("covers Devanagari in Noto Sans Devanagari", () => {
    const coverage = coverageOf(
      DEVANAGARI,
      classifyFace(sourceOnly(devanagari)).classify
    );
    expect(coverage.counts.source).toBe(countIn(devanagari, "Deva"));
    expect(coverage.percent).toBeGreaterThan(90);
    const ka = coverage.characters.find((entry) => entry.codePoint === KA);
    expect(ka?.status).toBe("source");
  });

  it("covers an explicit list and handles an empty one", () => {
    const { classify } = classifyFace(sourceOnly(lato));
    const coverage = coverageOf(
      { codePoints: [KA, 0x41, 0x42, 0x41], kind: "characters" },
      classify
    );
    const expected: CharacterCoverage[] = [
      { codePoint: 0x41, status: "source" },
      { codePoint: 0x42, status: "source" },
      { codePoint: KA, status: "missing" },
    ];
    expect(coverage.characters).toEqual(expected);
    expect(coverage.percent).toBeCloseTo(200 / 3, 10);
    const empty = coverageOf({ codePoints: [], kind: "characters" }, classify);
    expect(empty.total).toBe(0);
    expect(empty.percent).toBe(0);
  });

  describe("with edits, added glyphs and candidates", () => {
    const candidate = (
      id: string,
      characters: number[],
      status: CandidateStatus
    ): Candidate => ({
      advance: 600,
      characters,
      faceId: FACE_ID,
      id,
      name: id,
      outline: TRIANGLE,
      provenance: { origin: "manual" },
      ...(status === "rejected" ? { rejected: true as const } : {}),
    });

    const edited = (): FaceCharacters => {
      const glyphA = lato.glyphForCharacter(0x41) ?? -1;
      const glyphB = lato.glyphForCharacter(0x42) ?? -1;
      const changes: Change[] = [
        {
          advance: 700,
          faceId: FACE_ID,
          glyph: sourceGlyph(glyphA),
          kind: "advance-changed",
        },
        {
          faceId: FACE_ID,
          glyph: sourceGlyph(glyphB),
          kind: "outline-replaced",
          outline: TRIANGLE,
        },
        {
          faceId: FACE_ID,
          glyph: {
            advance: 600,
            // A new character, and one the source already had.
            characters: [KA, 0x43],
            key: "ka",
            name: "ka-deva",
            outline: TRIANGLE,
            provenance: { origin: "manual" },
          },
          kind: "glyph-added",
        },
      ];
      return {
        ...sourceOnly(lato),
        candidates: candidatesWithStatus(
          {
            ...emptyProject(),
            candidates: [
              candidate("kha", [KHA, 0x44], "proposed"),
              candidate("ga", [GA], "rejected"),
            ],
          },
          "proposed"
        ),
        working: foldChanges(changes),
      };
    };

    it("classifies each character once, by what the face now holds", () => {
      const { classify } = classifyFace(edited());
      expect(classify(0x41)).toBe("edited");
      expect(classify(0x42)).toBe("edited");
      expect(classify(0x43)).toBe("added");
      expect(classify(0x44)).toBe("source");
      expect(classify(0x45)).toBe("source");
      expect(classify(KA)).toBe("added");
      expect(classify(KHA)).toBe("candidate");
      expect(classify(GA)).toBe("missing");
      expect(classify(0x9_18)).toBe("missing");
    });

    it("moves counts between statuses without changing the total", () => {
      const before = coverageOf(LATIN, classifyFace(sourceOnly(lato)).classify);
      const after = coverageOf(LATIN, classifyFace(edited()).classify);
      const sharingA = lato.charactersForGlyph(
        lato.glyphForCharacter(0x41) ?? -1
      ).length;
      const sharingB = lato.charactersForGlyph(
        lato.glyphForCharacter(0x42) ?? -1
      ).length;
      expect(after.total).toBe(before.total);
      expect(after.counts.edited).toBe(sharingA + sharingB);
      expect(after.counts.added).toBe(1);
      expect(after.counts.source).toBe(
        before.counts.source - sharingA - sharingB - 1
      );
      expect(after.covered).toBe(before.covered);
      expect(after.percent).toBe(before.percent);
    });

    it("counts an added character as covered and a candidate as not", () => {
      const coverage = coverageOf(DEVANAGARI, classifyFace(edited()).classify);
      const expected: Record<CharacterStatus, number> = {
        added: 1,
        candidate: 1,
        edited: 0,
        missing: 162,
        source: 0,
      };
      expect(coverage.counts).toEqual(expected);
      expect(coverage.covered).toBe(1);
      expect(coverage.percent).toBeCloseTo(100 / 164, 10);
    });

    it("summarises a script the face only touches through new work", () => {
      const summary = coverageByScript(classifyFace(edited()));
      const deva = summary.find(
        (entry) => entry.scope.kind === "script" && entry.scope.code === "Deva"
      );
      expect(deva).toMatchObject({
        covered: 1,
        name: "Devanagari",
        total: 164,
      });
      expect(deva?.counts.candidate).toBe(1);
    });
  });

  it("summarises every script and shared group a face touches", () => {
    const classification = classifyFace(sourceOnly(sofia));
    const summary = coverageByScript(classification);
    const names = summary.map((entry) => entry.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "Latin",
        "Greek",
        "Cyrillic",
        "Punctuation",
        "Digits and numbers",
        "Symbols",
      ])
    );
    expect(names).not.toContain("Devanagari");
    expect(new Set(names).size).toBe(names.length);
    const covered = summary.map((entry) => entry.covered);
    expect(covered).toEqual([...covered].sort((a, b) => b - a));

    // Every character the face holds is counted in exactly one entry.
    const scoped = [...classification.characters].filter(
      (codePoint) => scopeOf(codePoint) !== undefined
    );
    expect(covered.reduce((sum, count) => sum + count, 0)).toBe(scoped.length);
    for (const entry of summary) {
      expect(entry.total).toBe(charactersIn(entry.scope).length);
      expect(entry.covered).toBe(
        coverageOf(entry.scope, classification.classify).covered
      );
      expect(entry.percent).toBeCloseTo(
        (entry.covered / entry.total) * 100,
        10
      );
    }
  });

  it("summarises a Devanagari face", () => {
    const summary = coverageByScript(classifyFace(sourceOnly(devanagari)));
    const deva = summary.find((entry) => entry.name === "Devanagari");
    expect(deva?.covered).toBe(countIn(devanagari, "Deva"));
    expect(deva?.total).toBe(164);
  });
});
