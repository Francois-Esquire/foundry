/** @vitest-environment happy-dom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverageStatistics } from "~/explorer/coverage-statistics";
import { CompositionPanel } from "~/library/composition-panel";
import { readFaceCoverage } from "~/library/face-coverage";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

// The language data loads on demand, and here it never arrives.
vi.mock("~/unicode/languages", () => ({
  languages: () => Promise.reject(new Error("The language data is gone.")),
}));

const NOT_LOADED = /The language data did not load/;

const latoCoverage = async () => {
  const workspace = testWorkspace();
  const { faceId } = await importOne(workspace, fixtureFile("lato"));
  return readFaceCoverage(
    workspace.getState().project,
    faceId,
    workspace.openFace(faceId)
  );
};

/** Lets the failed load reach the panel. */
const settle = () => act(async () => await Promise.resolve());

afterEach(cleanup);

describe("a place whose language data fails to load", () => {
  it("says so in a face's composition and stops waiting", async () => {
    render(
      <CompositionPanel coverage={await latoCoverage()} faceName="Lato" />
    );
    expect(
      screen.getByRole("progressbar", { name: "Reading the language data" })
    ).toBeTruthy();
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(NOT_LOADED);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says so in the coverage statistics, which still count the face", async () => {
    render(<CoverageStatistics coverage={await latoCoverage()} />);
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(NOT_LOADED);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("Characters in the face")).toBeTruthy();
  });
});
