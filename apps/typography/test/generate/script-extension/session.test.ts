/**
 * The script extension's session on real recorded output: Lato is extended
 * from the recorded Devanagari sheets, the extension is added as one
 * revision, the face is built and verified, and undo takes it out again.
 * Nothing here calls a model.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkRows,
  failureLines,
} from "~/generate/script-extension/check-rows";
import { faceStanding } from "~/generate/script-extension/face-standing";
import { scopeStatement } from "~/generate/script-extension/scope";
import {
  type FaceState,
  faceStateOf,
  type ScriptExtensionSession,
  type VerifiedExtension,
} from "~/generate/script-extension/session";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import type { MadeExtension } from "~/generation/script-extension/extend";
import {
  describeVerification,
  notVerified,
} from "~/generation/script-extension/verification-report";
import { weightNotes } from "~/generation/script-extension/weight-notes";
import { fetchedRuns } from "~/generation/strategies/recorded/source";
import { EMPTY_OUTLINE } from "~/typeface/outline";
import { findFace } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import { fixtureFile, importOne } from "../../helpers/workspace";
import { fixtureFetch } from "../helpers/session";
import { latoExtensionSession } from "./helpers/extension-session";

/** Starting the font engine and building a font can outlast the default limits. */
const ENGINE_TIMEOUT = 120_000;
const MODEL = "ideogram/vector/text-to-vector";
const KA = 0x09_15;
const HEADLINE_WEIGHT =
  /^Headline thickness of the new letters: \d+ units, against \d+ for the face's level strokes \(\d+%\)\.$/;
const STEM_WEIGHT = /^Upright stem of the new letters: \d+ units/;
const SHEET_NOT_FETCHED =
  /letters-ideogram-vector-medium\.svg could not be fetched \(404\)\.$/;

const finishedExtension = (
  session: ScriptExtensionSession,
  faceId: string
): MadeExtension => {
  const findings = session.shown(faceId)?.findings;
  if (!findings) {
    throw new Error("The session has no findings.");
  }
  return findings;
};

const verifiedOf = ({
  verification,
}: FaceState): VerifiedExtension & { readonly familyName: string } => {
  if (verification.status !== "finished") {
    throw new Error(
      `The verification is ${verification.status}: ${verification.status === "failed" ? verification.reason : ""}`
    );
  }
  return {
    ...verification.verified,
    familyName: verification.verified.report.familyName,
  };
};

describe("a script extension from the recorded run", () => {
  let session: ScriptExtensionSession;
  let workspace: Workspace;
  let faceId: string;
  /** Which steps were under way, in the order the session showed them. */
  const shown: string[] = [];
  /** What each step said while the second sheet was being read. */
  let midway: (string | undefined)[] = [];

  const face = () => faceStateOf(session.getState(), faceId);
  const standing = () => {
    const source = workspace.openFace(faceId);
    return faceStanding({
      face: findFace(workspace.getState().project, faceId),
      inSource: (character) =>
        source.glyphForCharacter(character) !== undefined,
      plan,
      project: workspace.getState().project,
    });
  };

  beforeAll(async () => {
    ({ faceId, session, workspace } = await latoExtensionSession());
    session.subscribe(() => {
      const { run } = face();
      const running =
        run.status === "running"
          ? run.steps.find((step) => step.status === "running")?.id
          : undefined;
      if (running && shown.at(-1) !== running) {
        shown.push(running);
      }
      if (run.status === "running" && running === "sheet:syllables") {
        midway = run.steps.map((step) => step.detail);
      }
    });
    await session.listSource();
    await session.run(faceId);
  }, ENGINE_TIMEOUT);

  it("finds the run's two sheets and the model that drew them", () => {
    const { source } = session.getState();
    expect(source.status).toBe("listed");
    const entries = source.status === "listed" ? source.entries : [];
    expect(entries.map((entry) => entry.output.name)).toEqual([
      "letters",
      "syllables",
    ]);
    expect(new Set(entries.map((entry) => entry.output.model))).toEqual(
      new Set([MODEL])
    );
    expect(entries[0]?.madeFrom).toEqual({ family: "Lato", style: "Regular" });
  });

  it("shows each step while it is under way and what each came to", () => {
    expect(shown).toEqual(["fetch", "sheet:letters", "sheet:syllables"]);
    // A sheet's figures are not known until the extension is whole.
    expect(midway).toEqual([
      "2 sheets fetched.",
      undefined,
      undefined,
      undefined,
    ]);
    const { run } = face();
    const steps = run.status === "finished" ? run.steps : [];
    expect(steps.map((step) => step.status)).toEqual([
      "finished",
      "finished",
      "finished",
      "finished",
    ]);
    expect(steps.map((step) => step.detail)).toEqual([
      "2 sheets fetched.",
      "10 glyphs made. 6 cells the plan does not list were set aside.",
      "8 glyphs made.",
      "18 glyphs settled, 0 not made.",
    ]);
  });

  it("makes every planned glyph as recorded output and puts nothing in the face", () => {
    const extension = finishedExtension(session, faceId);
    expect(extension.glyphs).toHaveLength(18);
    expect(extension.missing).toEqual([]);
    for (const glyph of extension.glyphs) {
      expect(glyph.provenance).toMatchObject({
        model: MODEL,
        origin: "generated",
        recorded: true,
      });
    }
    const { project } = workspace.getState();
    expect(project.head).toBe(0);
    expect(project.candidates).toEqual([]);
    expect(standing()).toEqual({ held: 0, kind: "lacking" });
  });

  it("says how the new letters' weight compares with the face's", () => {
    const notes = weightNotes(finishedExtension(session, faceId));
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(HEADLINE_WEIGHT);
    expect(notes[1]).toMatch(STEM_WEIGHT);
  });

  it("adds the whole extension as one revision, which undo takes out and redo puts back", () => {
    session.add(faceId);
    expect(face().refusal).toBeUndefined();
    const { project } = workspace.getState();
    expect(project.head).toBe(1);
    expect(project.revisions[0]?.label).toBe("Add a Devanagari subset");
    expect(project.revisions[0]?.changes).toHaveLength(19);
    expect(workspace.glyphForCharacter(faceId, KA)?.kind).toBe("added");
    expect(standing()).toEqual({ held: 15, kind: "in-face" });

    // Adding again, or running again, does nothing while it is in the face.
    session.add(faceId);
    expect(workspace.getState().project.head).toBe(1);

    workspace.undo();
    expect(workspace.glyphForCharacter(faceId, KA)).toBeUndefined();
    expect(standing()).toEqual({ held: 0, kind: "lacking" });
    workspace.redo();
    expect(standing()).toEqual({ held: 15, kind: "in-face" });
  });

  it(
    "verifies the built face: nine of nine words, and the identity check did not run",
    async () => {
      await session.verify(faceId);
      const verified = verifiedOf(face());
      const { report } = verified;
      expect(report.pass).toBe(true);
      // Lato reserves its name, so the font built for the checks leaves it out.
      expect(verified.familyName).toBe("Devanagari Subset");
      expect(verified.withheldName).toBe("Lato");
      expect(report.words.filter((word) => word.pass)).toHaveLength(9);
      expect(failureLines(report)).toEqual([]);

      const rows = checkRows(report);
      expect(rows.map((row) => [row.id, row.outcome, row.counted])).toEqual([
        ["built", "pass", ""],
        ["characters", "pass", "15 of 15"],
        ["forms", "pass", "3 of 3"],
        ["words", "pass", "9 of 9"],
        ["marks", "pass", "3 of 3"],
        ["headlines", "not-run", "8 of 9"],
        ["identity", "not-run", ""],
        ["latin", "pass", "4 of 4"],
      ]);
      expect(rows.find((row) => row.id === "identity")?.note).toContain(
        "Did not run"
      );
    },
    ENGINE_TIMEOUT
  );

  it("sets every test word in the built font's own outlines", () => {
    const verified = verifiedOf(face());
    expect(verified.words.map((line) => line.text)).toEqual(
      plan.words.map((word) => word.text)
    );
    verified.words.forEach((line, index) => {
      expect(line.glyphs).toHaveLength(plan.words[index]?.glyphs.length ?? 0);
      expect(line.glyphs.every((glyph) => glyph.added)).toBe(true);
      expect(line.width).toBeGreaterThan(0);
    });
    // सितार: the vowel sign is set first, at the start of the line.
    expect(verified.words[1]?.glyphs[0]?.x).toBe(0);
    expect(verified.latin.glyphs).toHaveLength("Hamburg".length);
    expect(verified.latin.glyphs.some((glyph) => glyph.added)).toBe(false);
  });

  it("carries the report's own list of what was not verified, in full", () => {
    const verified = verifiedOf(face());
    const report = describeVerification(
      finishedExtension(session, faceId),
      verified.report
    );
    expect(report).toContain(scopeStatement(plan));
    expect(verified.notVerified).toEqual(
      notVerified(finishedExtension(session, faceId), verified.report)
    );
    expect(verified.notVerified).toHaveLength(7);
    expect(verified.notVerified[0]).toContain(
      "This is not support for Devanagari or for a language written in it."
    );
    expect(verified.notVerified).toContainEqual(
      expect.stringContaining("Letter identity. No reference face was given")
    );
    for (const item of verified.notVerified) {
      expect(report).toContain(`- ${item}`);
    }
  });

  it("knows a verification is of a face that has since moved on", () => {
    const verified = verifiedOf(face());
    expect(verified.working).toBe(workspace.workingFace(faceId));
    workspace.undo();
    expect(verified.working).not.toBe(workspace.workingFace(faceId));
    workspace.redo();
    expect(verified.working).toBe(workspace.workingFace(faceId));
  });

  it(
    "runs the identity check once a font with these letters is in the project",
    async () => {
      await importOne(workspace, fixtureFile("devanagari"));
      await session.verify(faceId);
      const { report } = verifiedOf(face());
      expect(report.identity?.reference).toBe("Noto Sans Devanagari");
      const identity = checkRows(report).find((row) => row.id === "identity");
      expect(identity).toMatchObject({ counted: "10 of 10", outcome: "pass" });
      expect(identity?.note).toContain("says nothing about style");
    },
    ENGINE_TIMEOUT
  );
});

describe("a script extension that cannot go ahead", () => {
  it("says the recorded run is not served when it is not listed", async () => {
    const { session } = await latoExtensionSession({
      offering: { plan, recordedRun: "no-such-run" },
    });
    await session.listSource();
    expect(session.getState().source).toEqual({
      reason: "The recorded run no-such-run is not served with this app.",
      status: "failed",
    });
  });

  it("fails the listing with the reason when the index cannot be fetched, and lists on the next try", async () => {
    const network: { down: boolean } = { down: true };
    const { session } = await latoExtensionSession({
      runs: fetchedRuns("/", (address) =>
        network.down
          ? Promise.resolve(new Response(null, { status: 503 }))
          : fixtureFetch(address)
      ),
    });
    await session.listSource();
    expect(session.getState().source).toEqual({
      reason: "/recorded-runs/index.json could not be fetched (503).",
      status: "failed",
    });
    network.down = false;
    await session.listSource();
    expect(session.getState().source.status).toBe("listed");
  });

  it("fails the run on the step that was under way, with the reason", async () => {
    const network: { down: boolean } = { down: false };
    const { faceId, session, workspace } = await latoExtensionSession({
      runs: fetchedRuns("/", (address) =>
        network.down && address.endsWith(".svg")
          ? Promise.resolve(new Response(null, { status: 404 }))
          : fixtureFetch(address)
      ),
    });
    await session.listSource();
    network.down = true;
    await session.run(faceId);
    const { run } = faceStateOf(session.getState(), faceId);
    expect(run.status).toBe("failed");
    expect(run.status === "failed" && run.reason).toMatch(SHEET_NOT_FETCHED);
    expect(run.status === "failed" && run.steps[0]?.status).toBe("failed");
    expect(workspace.getState().project.head).toBe(0);
  });

  it("keeps the project's refusal when a planned character already has a glyph", async () => {
    const { faceId, session, workspace } = await latoExtensionSession();
    await session.listSource();
    await session.run(faceId);
    workspace.apply("Add one letter alone", [
      {
        faceId,
        glyph: {
          advance: 600,
          characters: [KA],
          key: "alone",
          name: "ka-alone",
          outline: EMPTY_OUTLINE,
          provenance: { origin: "manual" },
        },
        kind: "glyph-added",
      },
    ]);
    session.add(faceId);
    expect(workspace.getState().project.head).toBe(1);
    expect(faceStateOf(session.getState(), faceId).refusal).toBeTruthy();
  });
});
