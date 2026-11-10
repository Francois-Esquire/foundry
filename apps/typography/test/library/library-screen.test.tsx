/** @vitest-environment happy-dom */
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LibraryScreen from "~/library/library-screen";
import { saveBytes } from "~/workspace/files";
import { fontBytes } from "../helpers/fixtures";
import { fixtureFile, testWorkspace } from "../helpers/workspace";
import { renderScreen } from "./helpers/screen";

vi.mock("~/workspace/files", () => ({ saveBytes: vi.fn() }));

const SHOW_SOFIA = /Show Sofia Sans/;
const SHOW_LATO = /Show Lato/;
const LIGATURES = /^liga\b/;

const withFonts = async () => {
  const workspace = testWorkspace();
  await workspace.importFonts([fixtureFile("lato"), fixtureFile("sofia")]);
  return workspace;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LibraryScreen", () => {
  it("says what goes here and how to start while there is no font", () => {
    renderScreen(<LibraryScreen />);
    expect(screen.getByRole("heading", { name: "No fonts yet" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Import a font" }).getAttribute("href")
    ).toBe("#/import");
  });

  it("lists fonts by family and face, and shows a variable face's axes", async () => {
    renderScreen(<LibraryScreen />, await withFonts());
    const table = screen.getByRole("table", {
      name: "Fonts by family and face",
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Lato"),
      expect.stringContaining("Sofia Sans"),
    ]);
    expect(rows[0]?.textContent).toContain("Static");
    expect(rows[1]?.textContent).toContain("Variable: Weight 1 to 1000");
  });

  it("shows the chosen face: metadata, and a slider per axis only when it is variable", async () => {
    const workspace = await withFonts();
    renderScreen(<LibraryScreen />, workspace);
    expect(
      screen
        .getByRole("button", { name: SHOW_LATO })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.queryByRole("slider", { name: "Weight" })).toBeNull();
    expect(screen.getByText("Lato-Regular")).toBeTruthy();
    expect(screen.getByText("http://scripts.sil.org/OFL")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: SHOW_SOFIA }));
    expect(workspace.getState().activeFaceId).toBe(
      workspace.getState().project.faces[1]?.id
    );
    const weight = screen.getByRole("slider", { name: "Weight" });
    expect(weight.getAttribute("min")).toBe("1");
    expect(weight.getAttribute("max")).toBe("1000");
    expect(screen.getByRole("button", { name: "Black" })).toBeTruthy();
  });

  it("draws the specimen from outlines when the browser has no font, gaps as crossed boxes", async () => {
    renderScreen(<LibraryScreen />, await withFonts());
    const specimen = screen.getByRole("region", {
      name: "Text set in the face",
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Specimen text" }), {
      target: { value: "Aक" },
    });
    expect(specimen.querySelector('[data-setting="outlines"]')).toBeTruthy();
    expect(specimen.querySelectorAll("svg path")).toHaveLength(2);
    expect(specimen.querySelectorAll(".ty-outline-drawing-gap")).toHaveLength(
      1
    );
  });

  it("switches a layout feature and keeps the switch pressed", async () => {
    renderScreen(<LibraryScreen />, await withFonts());
    const ligatures = screen.getByRole("button", { name: LIGATURES });
    expect(ligatures.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(ligatures);
    expect(ligatures.getAttribute("aria-pressed")).toBe("false");
  });

  it("exports the imported file byte for byte", async () => {
    renderScreen(<LibraryScreen />, await withFonts());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Export original" }));
    });
    expect(saveBytes).toHaveBeenCalledTimes(1);
    const [fileName, bytes] = vi.mocked(saveBytes).mock.calls[0] ?? [];
    expect(fileName).toBe("Lato-Regular.ttf");
    expect(bytes).toEqual(fontBytes("lato"));
  });
});
