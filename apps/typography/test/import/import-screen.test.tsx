/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImportScreen from "~/import/import-screen";
import { FONTS, fontBytes, TRIANGLE } from "../helpers/fixtures";
import { textFile } from "../helpers/font-files";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";
import { renderScreen } from "../library/helpers/screen";

const FONTS_DIR = path.join(import.meta.dirname, "../fixtures/fonts");
const SAMPLES = [
  { file: FONTS.lato, licence: "Lato-OFL.txt" },
  { file: FONTS.sofia, licence: "SofiaSans-OFL.txt" },
];

const REMOVE_LATO = /^Remove Lato-Regular\.ttf/;
const LICENCE_LINK = /^Read the licence of Lato-Regular\.ttf/;

/** Serves the sample list and files the way the dev server does. */
const serveSamples = () =>
  vi.stubGlobal("fetch", async (address: string) => {
    const name = decodeURIComponent(address.replace("/samples/", ""));
    if (name === "index.json") {
      return Response.json(SAMPLES);
    }
    const known = SAMPLES.some(
      (sample) => sample.file === name || sample.licence === name
    );
    return known
      ? new Response(readFileSync(path.join(FONTS_DIR, name)))
      : new Response("", { status: 404 });
  });

const fileOf = (name: string, bytes: Uint8Array) =>
  new File([bytes as Uint8Array<ArrayBuffer>], name);

const choose = (files: readonly File[]) =>
  fireEvent.change(screen.getByLabelText("Add font files"), {
    target: { files },
  });

beforeEach(serveSamples);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ImportScreen", () => {
  it("says what goes here while nothing is imported", async () => {
    renderScreen(<ImportScreen />);
    expect(
      screen.getByText("Nothing is imported yet.", { exact: false })
    ).toBeTruthy();
    await screen.findByRole("table", {
      name: "Sample fonts and their licences",
    });
  });

  it("imports chosen files, and a bad file gets a notice without stopping the rest", async () => {
    const { workspace } = renderScreen(<ImportScreen />);
    choose([
      fileOf("notes.ttf", textFile()),
      fileOf(FONTS.lato, fontBytes("lato")),
    ]);
    const table = await screen.findByRole("table", {
      name: "Imported source fonts",
    });
    expect(
      within(table).getByRole("cell", { name: "Lato-Regular.ttf" })
    ).toBeTruthy();
    expect(within(table).getByText("Lato")).toBeTruthy();
    expect(
      workspace.getState().notices.map((notice) => notice.message)
    ).toEqual([expect.stringContaining("Could not import notes.ttf.")]);
    expect(
      screen.getByText(
        "1 font imported. 1 file could not be read, for the reasons given above."
      )
    ).toBeTruthy();
    expect(workspace.getState().project.sources).toHaveLength(1);
  });

  it("turns away a file that is not a font file before reading it", async () => {
    const { workspace } = renderScreen(<ImportScreen />);
    choose([fileOf("photo.png", Uint8Array.of(1, 2, 3))]);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "photo.png was not added."
    );
    expect(workspace.getState().project.sources).toHaveLength(0);
  });

  it("lists the samples with their licences and loads them with one action", async () => {
    const { workspace } = renderScreen(<ImportScreen />);
    const samples = await screen.findByRole("table", {
      name: "Sample fonts and their licences",
    });
    expect(
      within(samples).getByText("Copyright (c) 2010-2014", { exact: false })
    ).toBeTruthy();
    expect(
      within(samples)
        .getByRole("link", { name: LICENCE_LINK })
        .getAttribute("href")
    ).toBe("/samples/Lato-OFL.txt");

    fireEvent.click(screen.getByRole("button", { name: "Load sample fonts" }));
    await waitFor(() =>
      expect(workspace.getState().project.sources).toHaveLength(2)
    );
    expect(await screen.findByText("2 fonts imported.")).toBeTruthy();
    expect(screen.getByText("Every sample is in the project.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Load sample fonts" })
    ).toHaveProperty("disabled", true);
  });

  it("names the problem and the way out when the samples cannot be listed", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    renderScreen(<ImportScreen />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The sample fonts could not be listed."
    );
    serveSamples();
    fireEvent.click(
      screen.getByRole("button", { name: "List the samples again" })
    );
    await screen.findByRole("table", {
      name: "Sample fonts and their licences",
    });
  });

  it("removes a source font that carries no work at once", async () => {
    const workspace = testWorkspace();
    await importOne(workspace, fixtureFile("lato"));
    renderScreen(<ImportScreen />, workspace);
    fireEvent.click(screen.getByRole("button", { name: REMOVE_LATO }));
    expect(workspace.getState().project.sources).toHaveLength(0);
    expect(
      screen.queryByRole("table", { name: "Imported source fonts" })
    ).toBeNull();
  });

  it("asks before removing a font whose faces carry work, and can keep it", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("lato"));
    workspace.propose([
      {
        advance: 1200,
        characters: [0x9_15],
        faceId,
        id: "candidate",
        name: "ka-deva",
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
    ]);
    renderScreen(<ImportScreen />, workspace);

    fireEvent.click(screen.getByRole("button", { name: REMOVE_LATO }));
    expect(
      screen.getByText("Lato-Regular.ttf has 1 proposed candidate.", {
        exact: false,
      })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep font" }));
    expect(workspace.getState().project.sources).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: REMOVE_LATO }));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove font and work" })
    );
    expect(workspace.getState().project.sources).toHaveLength(0);
    expect(workspace.getState().project.candidates).toHaveLength(0);
  });

  it("closes the removal prompt when the work that raised it is undone", async () => {
    const workspace = testWorkspace();
    const { faceId } = await importOne(workspace, fixtureFile("lato"));
    workspace.apply("Widen A", [
      {
        advance: 1400,
        faceId,
        glyph: { glyphId: 4, kind: "source" },
        kind: "advance-changed",
      },
    ]);
    renderScreen(<ImportScreen />, workspace);

    fireEvent.click(screen.getByRole("button", { name: REMOVE_LATO }));
    expect(
      screen.getByText("Lato-Regular.ttf has 1 applied change.", {
        exact: false,
      })
    ).toBeTruthy();

    act(() => workspace.undo());
    expect(
      screen.queryByRole("button", { name: "Remove font and work" })
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Lato-Regular.ttf has");
    expect(screen.getByRole("button", { name: REMOVE_LATO })).toBeTruthy();

    // The prompt was closed, not hidden: bringing the work back does not reopen it.
    act(() => workspace.redo());
    expect(
      screen.queryByRole("button", { name: "Remove font and work" })
    ).toBeNull();

    // With no work left on it, the plain action removes the font at once.
    act(() => workspace.undo());
    fireEvent.click(screen.getByRole("button", { name: REMOVE_LATO }));
    expect(workspace.getState().project.sources).toHaveLength(0);
  });

  it("closes the removal prompt when the font is removed elsewhere", async () => {
    const workspace = testWorkspace();
    const { faceId, sourceId } = await importOne(
      workspace,
      fixtureFile("lato")
    );
    workspace.apply("Widen A", [
      {
        advance: 1400,
        faceId,
        glyph: { glyphId: 4, kind: "source" },
        kind: "advance-changed",
      },
    ]);
    renderScreen(<ImportScreen />, workspace);
    fireEvent.click(screen.getByRole("button", { name: REMOVE_LATO }));
    act(() => {
      workspace.removeSource(sourceId, { force: true });
    });
    expect(
      screen.queryByRole("button", { name: "Remove font and work" })
    ).toBeNull();
  });
});
