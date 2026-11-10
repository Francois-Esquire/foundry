/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { STYLE_SOURCE_NOTE, styleFacts } from "~/generate/style-facts";
import { StylePanel } from "~/generate/style-panel";
import { TRIANGLE } from "../helpers/fixtures";
import { latoSession } from "./helpers/session";

afterEach(cleanup);

const THE_FACE = /the face's letters|measured from the face\b/i;

describe("the style reference in Generate", () => {
  it("says it is measured from the source font as imported, and that edits are not counted", async () => {
    const { faceId, session, workspace } = await latoSession();
    const face = workspace
      .getState()
      .project.faces.find((known) => known.id === faceId);
    if (!face) {
      throw new Error("Lato was not imported.");
    }
    render(<StylePanel face={face} reading={session.styleOf(faceId)} />);
    const note = document.querySelector("[data-style-source]");
    expect(note?.textContent).toBe(STYLE_SOURCE_NOTE);
    expect(STYLE_SOURCE_NOTE).toContain("source font as imported");
    expect(STYLE_SOURCE_NOTE).toContain("are not counted");
    expect(
      screen.getByRole("table", { name: "What was measured from Lato Regular" })
        .textContent
    ).not.toMatch(THE_FACE);
  });

  it("is true: an edit to the face does not move what generation matches", async () => {
    const { faceId, session, workspace } = await latoSession();
    const before = session.styleOf(faceId);
    const glyph = workspace.glyphForCharacter(faceId, 0x48);
    if (!glyph) {
      throw new Error("Lato has no H.");
    }
    workspace.apply("Redraw H", [
      { faceId, glyph, kind: "outline-replaced", outline: TRIANGLE },
    ]);
    expect(session.styleOf(faceId).style).toEqual(before.style);
    for (const fact of styleFacts(before.style)) {
      expect(fact.note).not.toMatch(THE_FACE);
    }
  });
});
