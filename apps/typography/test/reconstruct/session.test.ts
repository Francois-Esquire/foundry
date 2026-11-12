import { beforeAll, describe, expect, it } from "vitest";
import type { RecoveredLetter } from "~/reconstruct/core";
import { letterKey } from "~/reconstruct/reading";
import type { ReconstructSession } from "~/reconstruct/session";
import { outlineBounds } from "~/typeface/outline";
import { isUnconfirmed } from "~/typeface/provenance";
import type { Workspace } from "~/workspace/workspace";
import {
  BANNER,
  bannerSession,
  codeOf,
  drawn,
  evidenceFile,
  librarySession,
  STOREFRONT,
} from "./helpers/session";

const SHA_256 = /^[0-9a-f]{64}$/;
const CAPITAL = /[A-Z]/;

const readingOf = (session: ReconstructSession) => {
  const {
    reading: { value: reading },
  } = session.getState();
  if (!reading) {
    throw new Error("The region was not read.");
  }
  return reading;
};

const proposalOf = (session: ReconstructSession) => {
  const {
    proposal: { value: proposal },
  } = session.getState();
  if (!proposal) {
    throw new Error(
      `Nothing was proposed: ${session.getState().proposal.problem}`
    );
  }
  return proposal;
};

const candidatesOn = (workspace: Workspace, faceId: string) =>
  workspace
    .getState()
    .project.candidates.filter((candidate) => candidate.faceId === faceId);

const topOf = ({ candidate }: RecoveredLetter) =>
  outlineBounds(candidate.outline)?.yMax ?? 0;

describe("opening evidence", () => {
  it("keeps the photograph byte for byte and names it by its digest", async () => {
    const { session } = await librarySession();
    const file = evidenceFile(STOREFRONT);
    const original = file.bytes.slice();
    await session.openEvidence(file);
    const { evidence } = session.getState();
    expect(evidence?.fileName).toBe(STOREFRONT);
    expect(evidence?.id).toMatch(SHA_256);
    expect(evidence?.file.bytes).toEqual(original);
    expect([evidence?.width, evidence?.height]).toEqual([1280, 960]);
  });

  it("suggests a family name for a new face from the file name", async () => {
    const { session } = await librarySession();
    await session.openEvidence(evidenceFile(STOREFRONT));
    expect(session.getState().destination).toEqual({
      familyName: "Storefront Needed Things",
      kind: "new",
    });
  });

  it("says what to do about a file that is not a picture", async () => {
    const { session } = await librarySession();
    await session.openEvidence({
      bytes: new TextEncoder().encode("not a picture"),
      fileName: "notes.png",
    });
    expect(session.getState().evidence).toBeUndefined();
    expect(session.getState().evidenceProblem).toBe(
      "notes.png could not be read as a picture. Choose a JPEG, PNG or WebP file."
    );
  });
});

describe("reading the storefront banner", () => {
  let session: ReconstructSession;

  beforeAll(async () => {
    ({ session } = await bannerSession());
  });

  it("finds the letters of both lines and reads most of them", () => {
    const { readings, references, sighting } = readingOf(session);
    expect(sighting.isolation.lines).toHaveLength(2);
    // NEEDED THINGS FOR SALE
    expect(readings).toHaveLength(19);
    expect(references).toBeGreaterThan(1);
    const read = readings.filter((reading) => reading.character !== undefined);
    expect(read.length).toBeGreaterThan(15);
    for (const reading of read) {
      expect(reading.labelledBy).toBe("recognizer");
      expect(reading.guesses[0]?.confidence).toBeGreaterThan(0);
    }
  });

  it("traces every labelled letter and scores how well each outline fits", () => {
    const { readings, recovery } = readingOf(session);
    const labelled = readings.filter(
      (reading) => reading.character !== undefined
    );
    expect(recovery.recovered).toHaveLength(labelled.length);
    expect(recovery.distinct.length).toBeLessThan(recovery.recovered.length);
    for (const letter of recovery.recovered) {
      expect(letter.fit).toBeGreaterThan(0.8);
      expect(letter.fit).toBeLessThanOrEqual(1);
      expect(letter.candidate.provenance).toMatchObject({
        basis: "observed",
        origin: "reconstructed",
      });
    }
  });

  it("ranks the library's faces by resemblance", () => {
    const { nearest } = readingOf(session);
    expect(nearest.length).toBeGreaterThan(1);
    const agreements = nearest.map((match) => match.agreement);
    expect(agreements).toEqual(agreements.toSorted((a, b) => b - a));
    // Sofia Sans is variable, so it stands in at its regular weight and at both ends.
    expect(nearest.map((match) => match.name)).toEqual(
      expect.arrayContaining([
        "Lato Regular",
        "Sofia Sans at weight 1",
        "Sofia Sans at weight 400",
        "Sofia Sans at weight 1000",
      ])
    );
    expect(nearest[0]?.name).toBe("Sofia Sans at weight 1000");
  });

  it("puts a person's label over the recogniser's and traces the letter as that character", async () => {
    const [first] = readingOf(session).readings;
    const key = letterKey(first ?? { index: 0, line: 0 });
    session.label(key, codeOf("Q"));
    await drawn();
    const relabelled = readingOf(session);
    expect(relabelled.readings[0]).toMatchObject({
      character: codeOf("Q"),
      labelledBy: "person",
    });
    expect(
      relabelled.recovery.distinct.map((letter) => letter.character)
    ).toContain(codeOf("Q"));

    session.label(key, undefined);
    await drawn();
    const without = readingOf(session);
    expect(without.readings[0]?.character).toBeUndefined();
    expect(without.recovery.recovered).toHaveLength(
      relabelled.recovery.recovered.length - 1
    );

    session.clearLabel(key);
    await drawn();
    expect(readingOf(session).readings[0]).toMatchObject({
      character: first?.character,
      labelledBy: "recognizer",
    });
  });

  it("reads again when the separation changes, and drops labels given to the old letters", async () => {
    const [first] = readingOf(session).readings;
    session.label(letterKey(first ?? { index: 0, line: 0 }), codeOf("Q"));
    await drawn();
    session.setOptions({ by: "tone" });
    await drawn();
    const {
      labels,
      reading: { value: reading },
    } = session.getState();
    expect(labels.size).toBe(0);
    expect(reading?.sighting.isolation.separation.by).toBe("tone");
    session.setOptions({ lettering: "lighter" });
    await drawn();
    expect(
      session.getState().reading.value?.sighting.isolation.separation
    ).toMatchObject({ lettering: "lighter", polarity: "given" });
    session.setOptions({ by: "colour", lettering: "automatic" });
    await drawn();
    expect(readingOf(session).readings).toHaveLength(19);
  });

  it("keeps labels when only the characters under consideration change", async () => {
    const [first] = readingOf(session).readings;
    const key = letterKey(first ?? { index: 0, line: 0 });
    session.label(key, codeOf("Q"));
    await drawn();
    session.setOptions({ considered: "capitals" });
    await drawn();
    expect(readingOf(session).readings[0]?.character).toBe(codeOf("Q"));
    session.clearLabel(key);
    await drawn();
    for (const reading of readingOf(session).readings) {
      const letter = String.fromCodePoint(reading.character ?? 0x41);
      expect(letter).toMatch(CAPITAL);
    }
  });
});

describe("proposing the observed letters", () => {
  it("proposes one candidate for each distinct character to a face in the project, scaled to its lines", async () => {
    const { lato, session, workspace } = await bannerSession();
    session.setOptions({ considered: "capitals" });
    await drawn();
    session.setDestination({ faceId: lato.faceId, kind: "existing" });
    await session.propose();
    const proposal = proposalOf(session);
    const candidates = candidatesOn(workspace, lato.faceId);
    expect(proposal.faceId).toBe(lato.faceId);
    expect(candidates).toHaveLength(proposal.letters.length);
    expect(new Set(candidates.flatMap((c) => c.characters)).size).toBe(
      candidates.length
    );
    const lines = workspace.openFace(lato.faceId).description.metrics;
    for (const letter of proposal.letters) {
      // Lato draws every capital, so each letter redraws a glyph it has.
      expect(letter.candidate.replaces).toBeDefined();
      expect(letter.candidate.provenance).toMatchObject({ basis: "observed" });
      expect(isUnconfirmed(letter.candidate.provenance)).toBe(false);
      expect(topOf(letter) / (lines.capHeight ?? 1)).toBeCloseTo(1, 0);
    }
  });

  it("makes a revision on the face for each accepted letter", async () => {
    const { lato, session, workspace } = await bannerSession();
    session.setDestination({ faceId: lato.faceId, kind: "existing" });
    await session.propose();
    const [first, second] = proposalOf(session).letters;
    expect(workspace.acceptCandidate(first?.candidate.id ?? "").ok).toBe(true);
    expect(workspace.acceptCandidate(second?.candidate.id ?? "").ok).toBe(true);
    const { project } = workspace.getState();
    expect(project.revisions).toHaveLength(2);
    expect(project.revisions.map((revision) => revision.accepts)).toEqual([
      first?.candidate.id,
      second?.candidate.id,
    ]);
    expect(workspace.workingFace(lato.faceId).overrides.size).toBe(2);
  });

  it("holds the region and the labels still once letters are proposed, until it is reopened", async () => {
    const { lato, session, workspace } = await bannerSession();
    session.setDestination({ faceId: lato.faceId, kind: "existing" });
    await session.propose();
    const proposed = candidatesOn(workspace, lato.faceId).length;
    const before = session.getState();
    session.label("0.0", codeOf("Q"));
    await drawn();
    session.markRegion(undefined);
    await drawn();
    session.setOptions({ by: "tone" });
    await drawn();
    expect(session.getState().reading.value).toBe(before.reading.value);
    expect(session.getState().region).toBe(BANNER);

    session.reopen();
    expect(session.getState().proposal.value).toBeUndefined();
    await session.propose();
    // The same letters of the same photograph are not proposed twice.
    expect(candidatesOn(workspace, lato.faceId)).toHaveLength(proposed);
    expect(proposalOf(session).letters).toHaveLength(proposed);
  });

  it("shows the candidate the project holds when a letter is proposed again from another marking", async () => {
    const { lato, session, workspace } = await bannerSession();
    session.setDestination({ faceId: lato.faceId, kind: "existing" });
    await session.propose();
    const first = proposalOf(session);
    expect(first.kept.size).toBe(0);

    session.reopen();
    session.setOptions({ scale: 3 });
    await drawn();
    await session.propose();
    const second = proposalOf(session);
    const held = new Map(
      candidatesOn(workspace, lato.faceId).map((candidate) => [
        candidate.id,
        candidate,
      ])
    );
    // A candidate cannot be withdrawn, so nothing was proposed twice.
    expect(held.size).toBe(
      new Set([...first.letters, ...second.letters].map((l) => l.candidate.id))
        .size
    );
    expect(second.kept.size).toBeGreaterThan(0);
    for (const { candidate } of second.letters) {
      // What the board draws is what accepting it puts in the face.
      expect(candidate.outline).toEqual(held.get(candidate.id)?.outline);
      expect(candidate.advance).toBe(held.get(candidate.id)?.advance);
    }
    const [kept] = [...second.kept];
    const earlier = first.letters.find((l) => l.candidate.id === kept);
    expect(held.get(kept ?? "")?.outline).toEqual(earlier?.candidate.outline);
    expect(workspace.acceptCandidate(kept ?? "").ok).toBe(true);
    const override = [
      ...workspace.workingFace(lato.faceId).overrides.values(),
    ].at(0);
    expect(override?.outline).toEqual(earlier?.candidate.outline);
  });

  it("names the problem when no face is chosen", async () => {
    const { session } = await bannerSession();
    session.setDestination({ faceId: undefined, kind: "existing" });
    await session.propose();
    expect(session.getState().proposal.value).toBeUndefined();
    expect(session.getState().proposal.problem).toBe(
      "Choose a face for the letters, or make a new face for them."
    );
  });

  it("makes a new face for the reconstruction and proposes the letters to it", async () => {
    const { session, workspace } = await bannerSession();
    session.setOptions({ considered: "capitals" });
    await drawn();
    const sourcesBefore = workspace.getState().project.sources.length;
    await session.propose();
    const proposal = proposalOf(session);
    const { project } = workspace.getState();
    const face = project.faces.find(
      (candidate) => candidate.id === proposal.faceId
    );
    expect(face?.description.familyName).toBe("Storefront Needed Things");
    expect(project.sources).toHaveLength(sourcesBefore + 1);
    // The project knows the app made this font, and that Lato was imported.
    expect(project.sources.map((source) => source.madeFor)).toEqual([
      undefined,
      undefined,
      "reconstruction",
    ]);
    expect(candidatesOn(workspace, proposal.faceId)).toHaveLength(
      proposal.letters.length
    );
    for (const letter of proposal.letters) {
      // The new face draws nothing, so every letter is added.
      expect(letter.candidate.replaces).toBeUndefined();
    }
    const [first] = proposal.letters;
    expect(workspace.acceptCandidate(first?.candidate.id ?? "").ok).toBe(true);
    expect(workspace.workingFace(proposal.faceId).added).toHaveLength(1);

    // Proposing again finds the face it made, and the new face is not read against.
    session.reopen();
    session.refresh();
    await drawn();
    await session.propose();
    expect(workspace.getState().project.sources).toHaveLength(
      sourcesBefore + 1
    );
    expect(proposalOf(session).faceId).toBe(proposal.faceId);
    expect(workspace.getState().notices).toEqual([]);
  }, 120_000);
});
