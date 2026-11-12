/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Application } from "~/application/application";
import StudioScreen from "~/studio/studio-screen";
import type { GlyphRef } from "~/typeface/changes";
import { glyphRefKey as glyphAddress } from "~/typeface/changes";
import { translateOutline } from "~/typeface/outline";
import type { Workspace } from "~/workspace/workspace";
import { testApplication } from "../helpers/application";
import { fixtureFile, importOne } from "../helpers/workspace";
import { renderInApplication } from "../library/helpers/screen";

const IMPORT_FIRST = /Import a font first/;
const FACE_NOT_IN_PROJECT = /The face in this address is not in the project/;

const LETTER_A = 0x61;
const PRIVATE_USE = 0xe0_00;

const revisions = (workspace: Workspace) =>
  workspace.getState().project.revisions.map((revision) => revision.label);

const specimenWidth = () =>
  Number(
    document
      .querySelector("svg.ty-studio-specimen-line")
      ?.getAttribute("data-width-units")
  );

const advanceField = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Advance, in font units",
  });

describe("the Studio screen", () => {
  let application: Application;
  let workspace: Workspace;

  beforeEach(async () => {
    application = await testApplication();
    ({ workspace } = application);
    window.location.hash = "";
  });

  afterEach(cleanup);

  it("says what it is for and where to start when no font is imported", () => {
    renderInApplication(<StudioScreen path={[]} />, application);
    expect(screen.getByText(IMPORT_FIRST)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to Import" }).getAttribute("href")
    ).toBe("#/import");
  });

  describe("with Lato", () => {
    let faceId: string;
    let glyph: GlyphRef;

    const openLetterA = () =>
      renderInApplication(
        <StudioScreen path={[faceId, glyphAddress(glyph)]} />,
        application
      );

    beforeEach(async () => {
      ({ faceId } = await importOne(workspace, fixtureFile("lato")));
      const found = workspace.glyphForCharacter(faceId, LETTER_A);
      if (!found) {
        throw new Error("Lato has an a.");
      }
      glyph = found;
    });

    it("opens the active face on its first letter when the address names nothing", () => {
      renderInApplication(<StudioScreen path={[]} />, application);
      expect(
        screen.getByRole("application", { name: "Outline of A" })
      ).toBeTruthy();
      expect(screen.getByText("3023 glyphs")).toBeTruthy();
    });

    it("says so when the address names a face the project lacks", () => {
      renderInApplication(<StudioScreen path={["nowhere"]} />, application);
      expect(screen.getByText(FACE_NOT_IN_PROJECT)).toBeTruthy();
    });

    it("records a run of nudges as one revision when attention leaves the drawing", () => {
      openLetterA();
      const drawing = screen.getByRole("application", { name: "Outline of a" });
      fireEvent.keyDown(drawing, { key: "PageDown" });
      fireEvent.keyDown(drawing, { key: "ArrowRight", shiftKey: true });
      fireEvent.keyDown(drawing, { key: "ArrowUp" });
      expect(revisions(workspace)).toEqual([]);
      expect(screen.getByText("in progress")).toBeTruthy();
      // The specimen already draws the moved glyph, before any revision exists.
      expect(
        document.querySelectorAll(
          'svg.ty-studio-specimen-line [data-made="true"]'
        )
      ).toHaveLength(1);
      fireEvent.blur(drawing);
      expect(revisions(workspace)).toEqual(["Move 1 point of a"]);
    });

    it("shows a changed advance in the specimen at once, and undo takes it back", () => {
      openLetterA();
      fireEvent.change(screen.getByRole("textbox", { name: "Specimen text" }), {
        target: { value: "banana" },
      });
      const before = specimenWidth();
      const source = Number(advanceField().value);
      fireEvent.change(advanceField(), {
        target: { value: String(source + 200) },
      });
      fireEvent.keyDown(advanceField(), { key: "Enter" });
      expect(revisions(workspace)).toEqual([
        `Set the advance of a to ${source + 200}`,
      ]);
      expect(specimenWidth()).toBe(before + 3 * 200);
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(specimenWidth()).toBe(before);
      expect(workspace.getState().project.head).toBe(0);
    });

    it("records an edit under way before undo, so undo undoes that edit", () => {
      openLetterA();
      const drawing = screen.getByRole("application", { name: "Outline of a" });
      fireEvent.keyDown(drawing, { key: "PageDown" });
      fireEvent.keyDown(drawing, { key: "ArrowRight" });
      fireEvent.keyDown(drawing, { key: "z", metaKey: true });
      expect(revisions(workspace)).toEqual(["Move 1 point of a"]);
      expect(workspace.getState().project.head).toBe(0);
    });

    it("edits the outline from the toolbar once something is selected", () => {
      openLetterA();
      const add = screen.getByRole<HTMLButtonElement>("button", {
        name: "Add node",
      });
      expect(add.disabled).toBe(true);
      const drawing = screen.getByRole("application", { name: "Outline of a" });
      fireEvent.keyDown(drawing, { key: "PageDown" });
      expect(add.disabled).toBe(false);
      fireEvent.click(add);
      fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
      expect(revisions(workspace)).toEqual([
        "Add a node to a",
        "Delete 1 node from a",
      ]);
    });

    it("splits a ligature in the composition when its feature is switched off", () => {
      openLetterA();
      fireEvent.change(screen.getByRole("textbox", { name: "Specimen text" }), {
        target: { value: "fi" },
      });
      const boxes = () =>
        screen
          .getByRole("table", { name: "The shaped run, one row per glyph box" })
          .querySelectorAll("tbody tr").length;
      expect(boxes()).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "liga" }));
      expect(boxes()).toBe(2);
    });

    it("accepts a candidate as a revision and opens it like any glyph", () => {
      const shape = workspace.workingGlyph(faceId, glyph);
      if (!shape) {
        throw new Error("Lato has an a.");
      }
      workspace.propose([
        {
          advance: shape.advance,
          characters: [PRIVATE_USE],
          faceId,
          id: "shifted",
          name: "a.shifted",
          outline: translateOutline(shape.outline, 30, 0),
          provenance: { origin: "manual" },
        },
      ]);
      openLetterA();
      fireEvent.click(screen.getByRole("button", { name: "Accept a.shifted" }));
      expect(revisions(workspace)).toEqual(["Accept a.shifted"]);
      expect(decodeURIComponent(window.location.hash)).toBe(
        `#/studio/${faceId}/a:shifted`
      );
    });
  });

  it("only shows a variable face, and pins an instance to edit", async () => {
    const { faceId } = await importOne(workspace, fixtureFile("sofia"));
    renderInApplication(<StudioScreen path={[faceId]} />, application);
    expect(
      screen.getByRole("heading", { name: "Pin an instance" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add node" })).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Advance, in font units" })
    ).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Named instance" }), {
      target: { value: "Black" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pin Black" }));
      await Promise.resolve();
    });
    const pinned = workspace
      .getState()
      .project.faces.find((face) => face.pinned);
    expect(pinned?.pinned).toEqual({
      location: { wght: 900 },
      styleName: "Black",
    });
    expect(decodeURIComponent(window.location.hash)).toContain(
      `#/studio/${pinned?.id}/`
    );
    expect(workspace.getState().activeFaceId).toBe(pinned?.id);
  });
});
