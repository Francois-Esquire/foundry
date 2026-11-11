/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImportScreen from "~/import/import-screen";
import { testApplication } from "../helpers/application";
import { FONTS } from "../helpers/fixtures";
import { renderInApplication } from "../library/helpers/screen";

const FONTS_DIR = path.join(import.meta.dirname, "../fixtures/fonts");
const SAMPLES = [
  { file: FONTS.lato, licence: "Lato-OFL.txt" },
  { file: FONTS.sofia, licence: "SofiaSans-OFL.txt" },
];
const SENTENCE_END = /[.!?](?=\s|$)/g;

/** Serves the sample list and files the way the dev server does. */
const serveSamples = () =>
  vi.stubGlobal("fetch", async (address: string) => {
    const name = decodeURIComponent(address.replace("/samples/", ""));
    return name === "index.json"
      ? Response.json(SAMPLES)
      : new Response(readFileSync(path.join(FONTS_DIR, name)));
  });

beforeEach(serveSamples);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the start, on an empty project", () => {
  it("says what the app does in two sentences and offers both ways in", async () => {
    renderInApplication(<ImportScreen />, await testApplication());
    const start = screen.getByRole("region", { name: "Start" });
    const said = start.querySelector(".ty-lede")?.textContent ?? "";
    expect(said.match(SENTENCE_END)).toHaveLength(2);
    expect(said).toContain("export");
    expect(said).toContain("photograph of lettering");
    expect(start.textContent).toContain("Bring a font");
    expect(start.textContent).toContain("Bring an image");
    expect(
      screen
        .getByRole("link", { name: "Open Reconstruct" })
        .getAttribute("href")
    ).toBe("#/reconstruct");
    expect(screen.getByLabelText("Add font files")).toBeTruthy();
    await screen.findByRole("table", {
      name: "Sample fonts and their licences",
    });
  });

  it("loads one sample font on its own, and then steps aside", async () => {
    const { workspace } = renderInApplication(
      <ImportScreen />,
      await testApplication()
    );
    fireEvent.click(
      await screen.findByRole("button", { name: `Load ${FONTS.lato}` })
    );
    await waitFor(() =>
      expect(
        workspace.getState().project.sources.map((source) => source.fileName)
      ).toEqual([FONTS.lato])
    );
    expect(screen.queryByRole("region", { name: "Start" })).toBeNull();
    const again = screen.getByRole("button", { name: `Load ${FONTS.lato}` });
    expect((again as HTMLButtonElement).disabled).toBe(true);
    // The other sample can be loaded once this one is kept as an artifact.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: `Load ${FONTS.sofia}`,
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
  });
});
