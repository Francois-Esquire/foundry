import { describe, expect, it } from "vitest";
import { revisionTitle } from "~/studio/revision-title";
import type { Revision } from "~/typeface/changes";
import type { Candidate } from "~/typeface/project";
import { TRIANGLE } from "../helpers/fixtures";

const candidate = (
  id: string,
  name: string,
  characters: readonly number[]
): Candidate => ({
  advance: 600,
  characters,
  faceId: "ab12:0",
  id,
  name,
  outline: TRIANGLE,
  provenance: { origin: "manual" },
});

const revision = (label: string, accepts?: string): Revision => ({
  accepts,
  changes: [],
  createdAt: "2026-11-10T09:00:00.000Z",
  id: label,
  label,
});

const CANDIDATES = [
  candidate("n", "uni004E", [0x4e]),
  candidate("ka", "ka-deva", [0x9_15]),
  candidate("half", "sa-deva.half", []),
];

describe("what a revision is called in the history", () => {
  it("leads with the character a candidate draws, when the interface can print it", () => {
    expect(revisionTitle(revision("Accept uni004E", "n"), CANDIDATES)).toBe(
      "Accept N, uni004E"
    );
  });

  it("keeps the label for a character the interface's type may not draw, and for a form with no character", () => {
    expect(revisionTitle(revision("Accept ka-deva", "ka"), CANDIDATES)).toBe(
      "Accept ka-deva"
    );
    expect(
      revisionTitle(revision("Accept sa-deva.half", "half"), CANDIDATES)
    ).toBe("Accept sa-deva.half");
  });

  it("keeps the label of any other revision, and of a candidate that has left the project", () => {
    expect(revisionTitle(revision("Move 1 point of N"), CANDIDATES)).toBe(
      "Move 1 point of N"
    );
    expect(revisionTitle(revision("Accept uni0058", "gone"), CANDIDATES)).toBe(
      "Accept uni0058"
    );
  });
});
