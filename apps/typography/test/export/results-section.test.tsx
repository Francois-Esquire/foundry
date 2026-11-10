/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuiltFont } from "~/export/build-run";
import { startDraft } from "~/export/plan-draft";
import { ResultsSection } from "~/export/results-section";
import type { BuildRun } from "~/export/session";
import { headRevisionId, type TypefaceProject } from "~/typeface/project";
import { describeFace } from "../helpers/fixtures";
import { startProject, withAnEdit } from "../packaging/helpers/projects";

afterEach(cleanup);

const CHANGED = /The project has changed since Atlas-Regular\.ttf was built/;

const builtFrom = (project: TypefaceProject, faceId: string): BuiltFont => ({
  builtAt: "2026-11-10T09:00:00.000Z",
  bytes: new Uint8Array(2048),
  faceId,
  fileName: "Atlas-Regular.ttf",
  id: "built-1",
  notes: [],
  report: { checks: [], passed: true },
  request: {
    added: [],
    faceIndex: 0,
    featureCode: [],
    overrides: new Map(),
    source: new Uint8Array(),
  },
  revisionId: headRevisionId(project),
  samples: [],
});

const renderResults = (
  font: BuiltFont,
  basis: TypefaceProject,
  now: TypefaceProject
) => {
  const run: BuildRun = {
    basis: { draft: startDraft(font.faceId), project: basis },
    outputs: [
      {
        faceId: font.faceId,
        fileName: font.fileName,
        progress: { font, status: "built" },
      },
    ],
    running: false,
  };
  render(
    <ResultsSection
      labels={new Map([[font.faceId, "Specimen Regular"]])}
      onBuildAgain={vi.fn()}
      outdated={basis !== now}
      project={now}
      run={run}
    />
  );
  return screen.getByTestId("built-font");
};

describe("a built font in Export", () => {
  it("says nothing more while the project is as it was built", () => {
    const { faceId, project } = startProject("Specimen.ttf", describeFace());
    const edited = withAnEdit(project, faceId);
    const entry = renderResults(builtFrom(edited, faceId), edited, edited);
    expect(entry.dataset.stale).toBe("false");
    expect(entry.textContent).not.toMatch(CHANGED);
  });

  it("says in its own entry that the project changed after it was built, and how to bring it up to date", () => {
    const { faceId, project } = startProject("Specimen.ttf", describeFace());
    const edited = withAnEdit(project, faceId);
    const again = withAnEdit(edited, faceId);
    const entry = renderResults(builtFrom(edited, faceId), edited, again);
    expect(entry.dataset.stale).toBe("true");
    expect(entry.textContent).toMatch(CHANGED);
    expect(entry.textContent).toContain("Build again to bring it up to date.");
  });
});
