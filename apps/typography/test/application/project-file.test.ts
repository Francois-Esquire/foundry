/**
 * A saved project opens again exactly as it was left.
 *
 * The cases are one sequence. They run in order on one project, and each
 * starts from what the case before it left.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Application } from "~/application/application";
import { sourceGlyph } from "~/typeface/changes";
import type { NewCandidate } from "~/typeface/project";
import { candidateStatuses } from "~/typeface/project";
import { TRIANGLE } from "../helpers/fixtures";
import {
  AT,
  fixtureAt,
  importLato,
  recordedRun,
  tempProject,
} from "./helpers/project";

const ISSUED_ID = /^id-\d+$/;

const proposal = (
  faceId: string,
  id: string,
  character: number
): NewCandidate => ({
  advance: 900,
  characters: [character],
  faceId,
  id,
  name: `${id}.proposed`,
  outline: TRIANGLE,
  provenance: {
    createdAt: AT,
    origin: "generated",
    runId: "run-by-hand",
    strategy: "procedural",
  },
});

describe("a project with every kind of thing in it", () => {
  const { open, remove, reopen } = tempProject();
  let app: Application;
  let lato = "";
  let pinned = "";

  beforeAll(async () => {
    app = await open();
    ({ faceId: lato } = await importLato(app));
    const sofia = await app.import([fixtureAt("fonts/SofiaSans-wght.ttf")]);
    const variable = sofia.fonts[0]?.faces[0]?.faceId ?? "";
    const { workspace } = app;
    const pin = workspace.pinInstance(variable, { wght: 700 }, "Bold");
    pinned = pin.ok ? pin.value.id : "";
    // An edit by hand to a source glyph, in the static face and the pinned one.
    workspace.apply("Redraw a glyph", [
      {
        faceId: lato,
        glyph: sourceGlyph(40),
        kind: "outline-replaced",
        outline: TRIANGLE,
      },
      {
        advance: 777,
        faceId: lato,
        glyph: sourceGlyph(40),
        kind: "advance-changed",
      },
      {
        faceId: pinned,
        glyph: sourceGlyph(12),
        kind: "outline-replaced",
        outline: TRIANGLE,
      },
    ]);
    workspace.apply("Add a glyph", [
      {
        faceId: lato,
        glyph: {
          advance: 1000,
          characters: [0xe0_00],
          key: "triangle",
          name: "triangle.added",
          outline: TRIANGLE,
          provenance: { origin: "manual" },
        },
        kind: "glyph-added",
      },
    ]);
    workspace.propose([
      proposal(lato, "accepted-one", 0xe0_01),
      proposal(lato, "rejected-one", 0xe0_02),
      proposal(lato, "waiting-one", 0xe0_03),
    ]);
    workspace.acceptCandidate("accepted-one");
    workspace.rejectCandidate("rejected-one");
    // A revision that is undone stays in the history, past the head.
    workspace.apply("Change an advance", [
      {
        advance: 555,
        faceId: lato,
        glyph: sourceGlyph(41),
        kind: "advance-changed",
      },
    ]);
    workspace.undo();
    workspace.renameProject("Atlas working file");
    workspace.setActiveFace(pinned);
    await app.generate({
      faceId: lato,
      kind: "script-extension",
      plan: "devanagari-subset",
      recordedRun: recordedRun("2026-11-10-devanagari-subset"),
    });
  });

  afterAll(async () => {
    await app.close();
    remove();
  });

  it("holds what the test set out to save", () => {
    const { project } = app.workspace.getState();
    expect(project.revisions).toHaveLength(4);
    expect(project.head).toBe(3);
    expect([...candidateStatuses(project).values()]).toEqual([
      "accepted",
      "rejected",
      "proposed",
    ]);
    expect(project.faces.find((face) => face.id === pinned)?.pinned).toEqual({
      location: { wght: 700 },
      styleName: "Bold",
    });
    expect(app.inspect().waiting.runs).toHaveLength(1);
  });

  it("opens again deep-equal: revisions, candidates, the pinned instance, ids and times", async () => {
    const before = app.workspace.getState();
    const inspected = app.inspect();
    app = await reopen(app);
    const after = app.workspace.getState();
    expect(after.project).toEqual(before.project);
    expect(after.activeFaceId).toBe(pinned);
    expect(app.inspect()).toEqual(inspected);
    // The source fonts are the bytes that were imported, not a rebuilt copy.
    expect(after.project.sources[0]?.bytes).toEqual(
      fixtureAt("fonts/Lato-Regular.ttf").bytes
    );
  });

  it("replays nothing: every revision keeps the id and the time it was given", () => {
    const { project } = app.workspace.getState();
    for (const revision of project.revisions) {
      expect(revision.id).toMatch(ISSUED_ID);
      expect(revision.createdAt).toBe(AT);
    }
    expect(project.sources.map((source) => source.importedAt)).toEqual([
      AT,
      AT,
    ]);
  });

  it("still takes undo, redo and edits after it is opened again", async () => {
    app.workspace.redo();
    expect(app.workspace.getState().project.head).toBe(4);
    app.workspace.undo();
    const applied = app.workspace.apply("Change another advance", [
      {
        advance: 444,
        faceId: pinned,
        glyph: sourceGlyph(13),
        kind: "advance-changed",
      },
    ]);
    expect(applied.ok).toBe(true);
    const { project } = app.workspace.getState();
    expect(project.head).toBe(4);
    expect(project.revisions.at(-1)?.label).toBe("Change another advance");
    app = await reopen(app);
    expect(app.workspace.getState().project).toEqual(project);
  });

  it("accepts the waiting run after two reopenings, whole", async () => {
    const [run] = app.inspect().waiting.runs;
    const accepted = await app.accept({ run: run?.runId ?? "" });
    expect(accepted).toMatchObject({ accepted: 18, revisions: 5 });
    const { project } = app.workspace.getState();
    app = await reopen(app);
    // Generated outlines and layout rules come back as they went in.
    expect(app.workspace.getState().project).toEqual(project);
    expect(app.inspect().waiting.runs).toEqual([]);
    expect(app.workspace.getState().project.revisions.at(-1)?.label).toBe(
      "Add a Devanagari subset"
    );
  });
});

describe("a project file that is not one", () => {
  it("refuses to open, and says why", async () => {
    const { artifacts, open, remove } = tempProject();
    const app = await open();
    await app.save();
    await app.close();
    const store = artifacts();
    const { items } = await store.list();
    const [project] = items;
    if (!project) {
      throw new Error("No project artifact was saved.");
    }
    await store.write({
      artifactId: project.id,
      changes: { put: { "project.json": { bytes: '{"format":99}' } } },
    });
    await expect(open()).rejects.toThrow("The saved project cannot be read");
    remove();
  });
});
