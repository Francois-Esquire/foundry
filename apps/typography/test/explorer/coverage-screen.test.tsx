/** @vitest-environment happy-dom */
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import CoverageScreen from "~/explorer/coverage-screen";
import { TRIANGLE } from "../helpers/fixtures";
import { fixtureFile, testWorkspace } from "../helpers/workspace";
import { renderScreen } from "../library/helpers/screen";

const KA = /^U\+0915, /;
const KHA = /^U\+0916, /;
const OUTLINE_TITLE = /^Outline of glyph \d+/;
const LATIN_A = /^U\+0041, in the source font/;
const DEVANAGARI_ROW = /Devanagari, 0 of 164/;

const withFonts = async () => {
  const workspace = testWorkspace();
  await workspace.importFonts([fixtureFile("lato"), fixtureFile("devanagari")]);
  return workspace;
};

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("CoverageScreen", () => {
  it("says what goes here and how to start while there is no font", () => {
    renderScreen(<CoverageScreen path={[]} />);
    expect(screen.getByRole("heading", { name: "No fonts yet" })).toBeTruthy();
  });

  it("opens on the script the face is mostly about, sectioned by block", async () => {
    renderScreen(<CoverageScreen path={[]} />, await withFonts());
    expect(
      screen.getByRole("heading", { level: 2, name: "Latin" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 3, name: "Basic Latin" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: LATIN_A })).toBeTruthy();
  });

  it("shows a script the face lacks as crossed boxes, and the other face's real glyphs", async () => {
    const workspace = await withFonts();
    renderScreen(<CoverageScreen path={["Deva"]} />, workspace);
    const lacking = screen.getByRole("button", { name: KA });
    expect(lacking.dataset.state).toBe("missing");
    expect(lacking.querySelector(".ty-tofu")).toBeTruthy();
    expect(
      (await screen.findByRole("link", { name: DEVANAGARI_ROW })).getAttribute(
        "href"
      )
    ).toBe("#/coverage/Deva");

    fireEvent.change(screen.getByRole("combobox", { name: "Face" }), {
      target: { value: workspace.getState().project.faces[1]?.id },
    });
    const covered = screen.getByRole("button", { name: KA });
    expect(covered.dataset.state).toBe("source");
    expect(covered.querySelector(".ty-tofu")).toBeNull();
    expect(covered.querySelector("svg path")?.getAttribute("d")).not.toBe("");
  });

  it("renders only the rows near the frame for a very large script", async () => {
    renderScreen(<CoverageScreen path={["Hani"]} />, await withFonts());
    const cells = screen
      .getByRole("region", { name: "Han characters" })
      .querySelectorAll("button");
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(400);
  });

  it("finds a character by code point and by words from its name", async () => {
    renderScreen(<CoverageScreen path={[]} />, await withFonts());
    const field = screen.getByRole("searchbox", { name: "Find a character" });
    fireEvent.change(field, { target: { value: "U+0915" } });
    const results = await screen.findByRole("region", {
      name: "Search results",
    });
    await waitFor(() =>
      expect(within(results).getByRole("button", { name: KA })).toBeTruthy()
    );
    expect(
      screen.getByRole("heading", { level: 3, name: "1 character found" })
    ).toBeTruthy();

    fireEvent.change(field, { target: { value: "devanagari ka" } });
    await waitFor(() => {
      const [first] = within(
        screen.getByRole("region", { name: "Search results" })
      ).getAllByRole("button");
      expect(first?.getAttribute("aria-label")).toMatch(KA);
    });
  });

  it("says so when nothing matches, with what to try", async () => {
    renderScreen(<CoverageScreen path={[]} />, await withFonts());
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Find a character" }),
      {
        target: { value: "0378-0379" },
      }
    );
    expect(
      await screen.findByText("No character matches this search.", {
        exact: false,
      })
    ).toBeTruthy();
  });

  it("inspects a chosen character: its name, its glyph and where it stands", async () => {
    renderScreen(<CoverageScreen path={[]} />, await withFonts());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: LATIN_A }));
    });
    const inspector = screen.getByRole("complementary", { name: "Character" });
    expect(
      await within(inspector).findByText("LATIN CAPITAL LETTER A")
    ).toBeTruthy();
    expect(within(inspector).getByText("U+0041")).toBeTruthy();
    expect(within(inspector).getByText("Uppercase Letter")).toBeTruthy();
    expect(within(inspector).getByText("Basic Latin")).toBeTruthy();
    expect(
      within(inspector).getByText("In the source font, unchanged")
    ).toBeTruthy();
    expect(
      within(inspector).getByRole("img").getAttribute("aria-label")
    ).toMatch(OUTLINE_TITLE);
    expect(
      within(inspector).getByRole("button", { name: "Show in Latin" })
    ).toBeTruthy();
  });

  it("shows an observed and an inferred candidate differently, in the grid and in the inspector", async () => {
    const workspace = await withFonts();
    const faceId = workspace.getState().project.faces[0]?.id ?? "";
    const candidate = (
      id: string,
      character: number,
      basis: "inferred" | "observed"
    ) => ({
      advance: 600,
      characters: [character],
      faceId,
      id,
      name: id,
      outline: TRIANGLE,
      provenance: {
        basis,
        evidenceId: "photograph",
        origin: "reconstructed",
      } as const,
    });
    workspace.propose([
      candidate("ka-observed", 0x9_15, "observed"),
      candidate("kha-inferred", 0x9_16, "inferred"),
    ]);
    renderScreen(<CoverageScreen path={["Deva"]} />, workspace);

    const observed = screen.getByRole("button", { name: KA });
    const inferred = screen.getByRole("button", { name: KHA });
    expect(observed.dataset.state).toBe("observed");
    expect(observed.getAttribute("aria-label")).toContain(
      "observed in the evidence, not accepted"
    );
    expect(observed.querySelectorAll(".ty-brackets > span")).toHaveLength(4);
    expect(inferred.dataset.state).toBe("candidate");
    expect(inferred.getAttribute("aria-label")).toContain(
      "candidate, not accepted"
    );
    expect(inferred.querySelector(".ty-brackets")).toBeNull();

    fireEvent.click(observed);
    const inspector = screen.getByRole("complementary", { name: "Character" });
    expect(inspector.querySelector(".ty-mark")?.getAttribute("data-kind")).toBe(
      "observed"
    );
    expect(inspector.textContent).toContain(
      "Observed in the evidence, not accepted."
    );
    expect(
      inspector.querySelector(".ty-coverage-figure")?.getAttribute("data-state")
    ).toBe("observed");

    // Accepted, it is work in the face, and the words still say what it was.
    act(() => {
      workspace.acceptCandidate("ka-observed");
    });
    expect(screen.getByRole("button", { name: KA }).dataset.state).toBe(
      "edited"
    );
    expect(inspector.querySelector(".ty-mark")?.getAttribute("data-kind")).toBe(
      "edited"
    );
    expect(inspector.textContent).toContain(
      "Observed in the evidence, accepted into the face"
    );
  });

  it("names the problem when the address names no writing system", async () => {
    renderScreen(<CoverageScreen path={["Klingon"]} />, await withFonts());
    expect(screen.getByRole("alert").textContent).toContain(
      "No writing system is called Klingon."
    );
  });

  it("gives statistics for the face and the languages it has the characters for", async () => {
    renderScreen(<CoverageScreen path={[]} />, await withFonts());
    const table = await screen.findByRole("table", {
      name: "Coverage by writing system",
    });
    expect(
      within(table).getByRole("rowheader", { name: "Devanagari" })
    ).toBeTruthy();
    expect(await screen.findByText("English", { exact: false })).toBeTruthy();
    expect(
      screen.getByText("a language is supported once its shaping", {
        exact: false,
      })
    ).toBeTruthy();
  });
});
