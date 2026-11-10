import { describe, expect, it } from "vitest";
import { statusLine } from "~/app/project-status";
import { sourceGlyph } from "~/typeface/changes";
import {
  commit,
  emptyProject,
  propose,
  rejectCandidate,
} from "~/typeface/project";
import { describeFace, TRIANGLE } from "../helpers/fixtures";
import { startProject } from "../packaging/helpers/projects";

const { faceId, project } = startProject("Specimen.ttf", describeFace());

const candidate = (id: string, character: number) => ({
  advance: 600,
  characters: [character],
  faceId,
  id,
  name: id,
  outline: TRIANGLE,
  provenance: { origin: "manual" } as const,
});

describe("the masthead's status line", () => {
  it("says an empty project has no fonts, and names the engine only once it has started", () => {
    expect(statusLine(emptyProject(), "idle")).toBe("No fonts yet");
    expect(statusLine(emptyProject(), "starting")).toBe(
      "No fonts yet, Starting the font engine"
    );
  });

  it("counts fonts and applied revisions first, in one run of words", () => {
    expect(statusLine(project, "idle")).toBe(
      "1 font, 0 revisions, Font engine not started"
    );
    const edited = commit(project, {
      changes: [
        {
          advance: 640,
          faceId,
          glyph: sourceGlyph(1),
          kind: "advance-changed",
        },
      ],
      label: "Widen a glyph",
    });
    expect(statusLine(edited, "ready")).toBe(
      "1 font, 1 revision, Font engine ready"
    );
  });

  it("counts candidates only while they wait for a decision", () => {
    const proposed = propose(project, [
      candidate("one", 0xe9),
      candidate("two", 0xe8),
    ]);
    expect(statusLine(proposed, "ready")).toBe(
      "1 font, 0 revisions, 2 candidates waiting, Font engine ready"
    );
    expect(statusLine(rejectCandidate(proposed, "one"), "failed")).toBe(
      "1 font, 0 revisions, 1 candidate waiting, Font engine did not start"
    );
  });
});
