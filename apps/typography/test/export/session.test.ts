import { describe, expect, it } from "vitest";
import { summariseReport } from "~/export/check-table";
import { faceFacts } from "~/export/face-facts";
import { featureLabel, featureTagsOf } from "~/export/feature-names";
import { startDraft } from "~/export/plan-draft";
import {
  builtFonts,
  changedSinceBuilt,
  createExportSession,
  type ExportMeans,
  isOutdated,
} from "~/export/session";
import type { ExportResolution } from "~/packaging/resolving";
import {
  addSource,
  headRevisionId,
  pinInstance,
  redo,
  type TypefaceProject,
  undo,
} from "~/typeface/project";
import { fixedClock } from "../helpers/fixed";
import { describeFace } from "../helpers/fixtures";
import {
  importFace,
  startProject,
  withAnEdit,
} from "../packaging/helpers/projects";

const WEIGHT = {
  default: 400,
  max: 900,
  min: 100,
  name: "Weight",
  tag: "wght",
};

/** A resolution with nothing to build, so no engine is needed. */
const NOTHING: ExportResolution = { outputs: [], problems: [], warnings: [] };

const unused = (): never => {
  throw new Error("Nothing is built in this test.");
};

/** A builder and a reader that fail when touched, whatever the ports grow to hold. */
const untouched = <Port extends object>(): Port =>
  new Proxy({}, { get: () => unused }) as Port;

const MEANS: ExportMeans = {
  builder: untouched(),
  charactersOfFace: () => [],
  clock: fixedClock,
  newId: () => "built-1",
  reader: untouched(),
};

describe("the export session", () => {
  it("keeps the draft and tells its listeners", () => {
    const session = createExportSession(MEANS);
    let calls = 0;
    const stop = session.subscribe(() => {
      calls += 1;
    });
    expect(session.getState()).toEqual({ draft: undefined, run: undefined });
    const draft = startDraft("face");
    session.setDraft(draft);
    expect(session.getState().draft).toBe(draft);
    expect(calls).toBe(1);
    stop();
    session.setDraft(startDraft("other"));
    expect(calls).toBe(1);
  });

  it("records what a run was built from, and sees when that has changed", async () => {
    const { faceId, project } = startProject("Specimen.ttf", describeFace());
    const session = createExportSession(MEANS);
    const draft = startDraft(faceId);
    await session.build({ draft, project }, NOTHING);
    const { run } = session.getState();
    if (!run) {
      throw new Error("The session kept no run.");
    }
    expect(run).toMatchObject({ outputs: [], running: false });
    expect(builtFonts(session.getState())).toEqual([]);
    // The same choices made again are the same plan.
    expect(isOutdated(run, { draft: { ...draft }, project })).toBe(false);
    expect(
      isOutdated(run, { draft: { ...draft, format: "woff2" }, project })
    ).toBe(true);
    expect(
      isOutdated(run, { draft, project: withAnEdit(project, faceId) })
    ).toBe(true);
  });
});

describe("a built font and the project it was built from", () => {
  const built = (project: TypefaceProject) => ({
    revisionId: headRevisionId(project),
  });

  it("has not changed while the same revisions are applied", () => {
    const { faceId, project } = startProject("Specimen.ttf", describeFace());
    expect(changedSinceBuilt(built(project), project)).toBe(false);
    const edited = withAnEdit(project, faceId);
    expect(changedSinceBuilt(built(edited), edited)).toBe(false);
    // A rename is not a change to any font.
    expect(
      changedSinceBuilt(built(edited), { ...edited, name: "Another name" })
    ).toBe(false);
    // Undone and redone, the project is where the font was built.
    expect(changedSinceBuilt(built(edited), redo(undo(edited)))).toBe(false);
  });

  it("has changed once a revision is applied or undone after the build", () => {
    const { faceId, project } = startProject("Specimen.ttf", describeFace());
    const edited = withAnEdit(project, faceId);
    expect(changedSinceBuilt(built(project), edited)).toBe(true);
    expect(changedSinceBuilt(built(edited), undo(edited))).toBe(true);
    expect(changedSinceBuilt(built(edited), withAnEdit(edited, faceId))).toBe(
      true
    );
  });

  it("sees an undo followed by another edit, which leaves the count of revisions the same", () => {
    const { faceId, project } = startProject("Specimen.ttf", describeFace());
    const edited = withAnEdit(project, faceId);
    const another = withAnEdit(undo(edited), faceId);
    expect(another.head).toBe(edited.head);
    expect(changedSinceBuilt(built(edited), another)).toBe(true);
  });
});

describe("what the screen says about faces and features", () => {
  it("knows a face whose source font the app made for a reconstruction", () => {
    const imported = startProject("Specimen.ttf", describeFace());
    const project = addSource(
      imported.project,
      {
        bytes: new Uint8Array([1]),
        fileName: "Storefront-Regular.ttf",
        id: "storefront".padEnd(64, "0"),
        importedAt: "2026-11-10T09:00:00.000Z",
        madeFor: "reconstruction",
      },
      [describeFace({ familyName: "Storefront" })]
    );
    expect(
      faceFacts(project).map(({ label, reconstructed }) => [
        label,
        reconstructed,
      ])
    ).toEqual([
      ["Specimen Regular", false],
      ["Storefront Regular", true],
    ]);
  });

  it("describes static, variable, pinned and changed faces", () => {
    const first = startProject("Specimen.ttf", describeFace());
    const second = importFace(
      first.project,
      "Flex.ttf",
      describeFace({ axes: [WEIGHT], familyName: "Flex" })
    );
    const pinned = pinInstance(
      second.project,
      second.faceId,
      { wght: 700 },
      "Bold"
    );
    const project = withAnEdit(pinned.project, first.faceId);
    expect(
      faceFacts(project).map(({ changes, label, note }) => [
        label,
        note,
        changes,
      ])
    ).toEqual([
      ["Flex Regular", "Variable, 1 axis.", 0],
      ["Flex Bold", "Pinned at wght 700.", 0],
      ["Specimen Regular", "Static. 1 change.", 1],
    ]);
  });

  it("names the features it knows and lists a face's tags once", () => {
    expect(featureLabel("liga")).toBe("liga, Standard ligatures");
    expect(featureLabel("ss03")).toBe("ss03, Stylistic set 3");
    expect(featureLabel("cv11")).toBe("cv11, Character variant 11");
    expect(featureLabel("zzzz")).toBe("zzzz");
    const { project } = startProject(
      "Specimen.ttf",
      describeFace({
        layout: {
          positioning: ["kern", "mark"],
          scripts: ["latn"],
          substitution: ["liga", "kern"],
        },
      })
    );
    expect(featureTagsOf(project.faces, () => [])).toEqual([
      "kern",
      "liga",
      "mark",
    ]);
    // Features the project wrote itself can be chosen too.
    expect(
      featureTagsOf(project.faces, () => [
        "feature akhn { sub a b by c; } akhn; feature liga { } liga;",
      ])
    ).toEqual(["akhn", "kern", "liga", "mark"]);
  });

  it("never counts a check that did not run as passed", () => {
    const check = (outcome: "pass" | "fail" | "not-run") => ({
      details: [],
      id: "engine" as const,
      message: "",
      outcome,
    });
    expect(
      summariseReport({ checks: [check("pass"), check("pass")], passed: true })
    ).toBe("2 of 2 checks passed");
    expect(
      summariseReport({
        checks: [check("pass"), check("not-run"), check("fail")],
        passed: false,
      })
    ).toBe("1 of 3 checks passed, 1 failed, 1 did not run");
  });
});
