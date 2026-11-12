import { describe, expect, it } from "vitest";
import { type Change, sourceGlyph } from "~/typeface/changes";
import {
  acceptRun,
  addSource,
  commit,
  emptyProject,
  type HeldRun,
  holdRun,
  propose,
  redo,
  undo,
  waitingRuns,
} from "~/typeface/project";
import { removeSource, sourceUsage } from "~/typeface/removal";
import { stamp } from "../helpers/fixed";
import { describeFace, TRIANGLE } from "../helpers/fixtures";

const base = () =>
  addSource(
    emptyProject(),
    {
      bytes: new Uint8Array([1]),
      fileName: "font.ttf",
      id: "font",
      importedAt: stamp().at,
    },
    [describeFace(), describeFace()]
  );
const run = (runId: string, faceId = "font:0"): HeldRun => ({
  changes: [
    {
      faceId,
      glyph: {
        advance: 600,
        characters: [0x9_15],
        key: runId,
        name: "ka",
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
      kind: "glyph-added",
    },
    { code: "", description: "Rules", faceId, kind: "features-added" },
  ] satisfies Change[],
  faceId,
  glyphs: 1,
  modelOutput: "output",
  runId,
  script: "Devanagari",
});
const waiting = (project: ReturnType<typeof base>) =>
  waitingRuns(project).map(({ runId }) => runId);

describe("C2: a run waits while the project would accept it", () => {
  it("follows acceptance, undo and redo without changing another face", () => {
    const held = holdRun(holdRun(base(), run("first")), run("other", "font:1"));
    expect(waiting(held)).toEqual(["first", "other"]);
    const accepted = acceptRun(held, "first", stamp());
    expect(waiting(accepted)).toEqual(["other"]);
    expect(waiting(undo(accepted))).toEqual(["first", "other"]);
    expect(waiting(redo(undo(accepted)))).toEqual(["other"]);
    expect(accepted.runs).toEqual(held.runs);
  });

  it("leaves both runs held when accepting one takes the other's names", () => {
    const held = holdRun(
      holdRun(holdRun(base(), run("first")), run("second")),
      run("other", "font:1")
    );
    expect(waiting(held)).toEqual(["first", "second", "other"]);
    const accepted = acceptRun(held, "second", stamp());
    expect(waiting(accepted)).toEqual(["other"]);
    expect(waiting(undo(accepted))).toEqual(["first", "second", "other"]);
    expect(accepted.runs).toEqual(held.runs);
  });

  it("needs no acceptance id on the revision that took the names", () => {
    const held = holdRun(holdRun(base(), run("first")), run("other", "font:1"));
    const accepted = commit(held, {
      ...stamp(),
      changes: run("old").changes,
      label: "Old extension",
    });
    expect(accepted.revisions[0]?.acceptsRun).toBeUndefined();
    expect(waiting(accepted)).toEqual(["other"]);
    expect(waiting(undo(accepted))).toEqual(["first", "other"]);
  });
});

describe("C6: removal asks", () => {
  it("refuses a font with only a waiting run unless forced", () => {
    const held = holdRun(base(), run("first"));
    expect(sourceUsage(held, "font")).toEqual({
      appliedChanges: 0,
      proposedCandidates: 0,
      waitingRuns: 1,
    });
    expect(() => removeSource(held, "font")).toThrow(
      "font.ttf has 1 waiting run. Undo or settle them first, or remove the font together with that work."
    );
    expect(removeSource(held, "font", { force: true }).runs).toEqual([]);
    expect(held.runs).toHaveLength(1);
  });

  it("counts every kind of work a font has in one sentence", () => {
    const edited = commit(holdRun(base(), run("first")), {
      ...stamp(),
      changes: [
        {
          advance: 700,
          faceId: "font:1",
          glyph: sourceGlyph(1),
          kind: "advance-changed",
        },
      ],
      label: "Widen",
    });
    const worked = propose(edited, [
      {
        advance: 600,
        characters: [0xe0_00],
        faceId: "font:1",
        id: "candidate",
        name: "new",
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
    ]);
    expect(() => removeSource(worked, "font")).toThrow(
      "font.ttf has 1 applied change, 1 proposed candidate and 1 waiting run. Undo or settle them first, or remove the font together with that work."
    );
  });
});
