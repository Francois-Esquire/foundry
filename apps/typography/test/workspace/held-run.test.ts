/** Holding and accepting a run through the workspace. */
import { describe, expect, it } from "vitest";
import type { HeldRun } from "~/typeface/project";
import { waitingRuns } from "~/typeface/project";
import { TRIANGLE } from "../helpers/fixtures";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

const runAdding = (faceId: string, name: string): HeldRun => ({
  changes: [
    {
      faceId,
      glyph: {
        advance: 600,
        characters: [0x09_15],
        key: "held-glyph",
        name,
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
      kind: "glyph-added",
    },
    { code: "", description: "Rules", faceId, kind: "features-added" },
  ],
  faceId,
  glyphs: 1,
  modelOutput: "output",
  runId: "run",
  script: "Devanagari",
});

describe("a run held through the workspace", () => {
  it("is refused when it names a glyph as the source font does, so it never waits", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("lato"));
    const taken = workspace.openFace(faceId).glyphName(1);
    const held = workspace.holdRun(runAdding(faceId, taken));
    expect(held.ok).toBe(false);
    expect(!held.ok && held.notice.message).toBe(
      `The source font already has a glyph named ${taken}. Give the new glyph another name.`
    );
    const { project } = workspace.getState();
    expect(project.runs).toEqual([]);
    expect(waitingRuns(project)).toEqual([]);
  });

  it("is accepted when it waits: the waiting list and acceptance agree", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("lato"));
    expect(workspace.holdRun(runAdding(faceId, "ka-deva")).ok).toBe(true);
    for (const { runId } of waitingRuns(workspace.getState().project)) {
      expect(workspace.acceptRun(runId).ok).toBe(true);
    }
    expect(workspace.getState().project.head).toBe(1);
    expect(waitingRuns(workspace.getState().project)).toEqual([]);
  });
});
