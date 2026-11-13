// @vitest-environment happy-dom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Application } from "~/application/application";
import { RECORDED_LABEL } from "~/generate/provenance-facts";
import { faceStanding } from "~/generate/script-extension/face-standing";
import { NotesPanel } from "~/generate/script-extension/notes-panel";
import { ResultBoard } from "~/generate/script-extension/result-board";
import { ScriptExtensionPlace } from "~/generate/script-extension/script-extension-place";
import { faceStateOf } from "~/generate/script-extension/session";
import { EMPTY_OUTLINE } from "~/typeface/outline";
import { findFace, waitingRuns } from "~/typeface/project";
import { renderInApplication } from "../library/helpers/screen";
import { EXTENSION, sharedExtension } from "./helpers/shared-extension";

const ADD = /Add the whole extension/;

const apps: Application[] = [];
const open = async () => {
  const held = await sharedExtension();
  apps.push(held.app);
  return held;
};
const project = (app: Application) => app.workspace.getState().project;
const replay = async (app: Application, faceId: string) => {
  const session = app.places.screen.scriptExtension();
  await session.listSource();
  await waitFor(() => expect(session.getState().source.status).toBe("listed"));
  await session.run(faceId);
  return session;
};
const renderPage = (app: Application, faceId: string) =>
  renderInApplication(
    <ScriptExtensionPlace face={findFace(project(app), faceId)} />,
    app
  );
/** The ids of the runs the project would accept now. */
const waitingIds = (app: Application) =>
  waitingRuns(project(app)).map(({ runId }) => runId);
const standingOf = (app: Application, faceId: string) =>
  faceStanding({
    face: findFace(project(app), faceId),
    inSource: (character) =>
      app.workspace.openFace(faceId).glyphForCharacter(character) !== undefined,
    plan: app.places.screen.scriptExtension().offering.plan,
    project: project(app),
  });
const RECORDED = `${RECORDED_LABEL}, replayed`;
const NO_NOTES = "The run reported no notes.";
const NO_EVALUATION =
  "Not evaluated. The run kept no evaluation for this glyph.";
const NO_MAKING = "Made by Not recorded.";
const NO_FINDINGS =
  "This run was not made on this page. What its making found of each glyph, its notes and its sheets are not kept with the project.";
const NO_VERIFICATION =
  "Verification reads where the marks attach, which the making found and the project does not keep. To verify this extension, undo it and make it again on this page.";

afterEach(async () => {
  cleanup();
  for (const app of apps.splice(0)) {
    await app.close();
  }
});

it("S1: a command run is shown and Add accepts it", async () => {
  const command = await open();
  const made = await command.app.generate({
    ...EXTENSION,
    faceId: command.faceId,
  });
  const session = command.app.places.screen.scriptExtension();
  expect(session.shown(command.faceId)?.runId).toBe(made.runId);
  expect(waitingIds(command.app)).toEqual([made.runId]);
  expect(session.shown(command.faceId)?.shown.glyphs).toHaveLength(18);
  const page = renderPage(command.app, command.faceId);
  expect(page.getByRole("button", { name: ADD }).hasAttribute("disabled")).toBe(
    false
  );
  fireEvent.click(page.getByRole("button", { name: ADD }));
  cleanup();
  expect(project(command.app).head).toBe(1);
  expect(project(command.app).revisions[0]?.acceptsRun).toBe(made.runId);
  expect(command.app.inspect().waiting.runs).toEqual([]);
  await session.verify(command.faceId);
  expect(
    faceStateOf(session.getState(), command.faceId).verification.status
  ).toBe("idle");
}, 120_000);

it("S2: a screen run is accepted by command and leaves the same project", async () => {
  const command = await open();
  const screen = await open();
  await command.app.generate({ ...EXTENSION, faceId: command.faceId });
  command.app.places.screen.scriptExtension().add(command.faceId);
  const screenSession = await replay(screen.app, screen.faceId);
  const [held] = screen.app.inspect().waiting.runs;
  expect(held).toMatchObject({ faceId: screen.faceId, glyphs: 18 });
  await screen.app.accept({ run: held?.runId ?? "" });
  expect(screenSession.shown(screen.faceId)?.findings).toBeDefined();
  expect(screenSession.shown(screen.faceId)?.runId).toBeUndefined();
  expect(standingOf(screen.app, screen.faceId).kind).toBe("in-face");
  const acceptedPage = renderPage(screen.app, screen.faceId);
  expect(
    acceptedPage.getByRole("button", { name: ADD }).hasAttribute("disabled")
  ).toBe(true);
  await screenSession.verify(screen.faceId);
  expect(
    faceStateOf(screenSession.getState(), screen.faceId).verification.status
  ).toBe("finished");
  expect(project(command.app)).toEqual(project(screen.app));
}, 120_000);

it("S3: reopening shows waiting and applied glyphs without changing project or ids", async () => {
  const held = await open();
  const made = await held.app.generate({ ...EXTENSION, faceId: held.faceId });
  const original = held.app.places.screen.scriptExtension().shown(held.faceId);
  expect(original?.shown.glyphs).toHaveLength(18);
  let { app } = held;
  for (const standing of ["lacking", "in-face"]) {
    app = await held.reopen(app);
    apps.push(app);
    const before = structuredClone(project(app));
    const ids = held.ids();
    const shown = app.places.screen.scriptExtension().shown(held.faceId);
    expect(standingOf(app, held.faceId).kind).toBe(standing);
    // A waiting run is shown by its id. In the face, no held run stands for it.
    expect(shown?.runId).toBe(standing === "lacking" ? made.runId : undefined);
    expect(shown?.shown.glyphs).toHaveLength(18);
    expect(shown?.shown.glyphs).toEqual(original?.shown.glyphs);
    expect(shown?.findings).toBeUndefined();
    expect(project(app)).toEqual(before);
    expect(held.ids()).toBe(ids);
    if (standing === "lacking") {
      await app.accept({ run: made.runId });
    }
  }
}, 120_000);

it("S4: the page prefers its own waiting run and a reopening prefers the newest", async () => {
  const held = await open();
  await held.app.generate({ ...EXTENSION, faceId: held.faceId });
  const session = await replay(held.app, held.faceId);
  const ownId = faceStateOf(session.getState(), held.faceId).runId;
  // A later command run proves the page prefers its own run over the newest.
  // Reopening then drops that preference.
  const newest = await held.app.generate({ ...EXTENSION, faceId: held.faceId });
  expect(session.shown(held.faceId)?.runId).toBe(ownId);
  expect(waitingIds(held.app)).toContain(ownId);
  session.add(held.faceId);
  expect(project(held.app).revisions[0]?.acceptsRun).toBe(ownId);
  held.app.workspace.undo();
  const later = await held.reopen(held.app);
  apps.push(later);
  expect(later.places.screen.scriptExtension().shown(held.faceId)?.runId).toBe(
    newest.runId
  );
  expect(waitingIds(later).at(-1)).toBe(newest.runId);
  const laterSession = await replay(later, held.faceId);
  const chosen = faceStateOf(laterSession.getState(), held.faceId).runId;
  laterSession.add(held.faceId);
  expect(project(later).revisions[0]?.acceptsRun).toBe(chosen);
  expect(project(later).runs).toHaveLength(4);
}, 120_000);

const addAlone = (app: Application, faceId: string) =>
  app.workspace.apply("Add one letter alone", [
    {
      faceId,
      glyph: {
        advance: 600,
        characters: [0x09_15],
        key: "alone",
        name: "ka-alone",
        outline: EMPTY_OUTLINE,
        provenance: { origin: "manual" },
      },
      kind: "glyph-added",
    },
  ]);

it("S4: a page without its own run hides a blocked held run and explains the standing", async () => {
  const { app, faceId } = await open();
  await app.generate({ ...EXTENSION, faceId });
  expect(addAlone(app, faceId).ok).toBe(true);
  const session = app.places.screen.scriptExtension();
  expect(project(app).runs).toHaveLength(1);
  expect(app.inspect().waiting.runs).toEqual([]);
  expect(session.shown(faceId)).toBeUndefined();
  const before = structuredClone(project(app));
  session.add(faceId);
  expect(project(app)).toEqual(before);
  const page = renderPage(app, faceId);
  expect(page.queryByRole("heading", { name: "Result" })).toBeNull();
  expect(page.queryByRole("button", { name: ADD })).toBeNull();
  const standing = standingOf(app, faceId);
  expect(standing.kind).toBe("not-offered");
  if (standing.kind !== "not-offered") {
    throw new Error("The character did not block the extension.");
  }
  expect(
    within(page.getByRole("region", { name: "Run" })).getByText(standing.reason)
  ).toBeDefined();
}, 120_000);

it("S4: a page keeps its own blocked run and Add retains the project refusal", async () => {
  const { app, faceId } = await open();
  const session = await replay(app, faceId);
  const before = session.shown(faceId);
  expect(addAlone(app, faceId).ok).toBe(true);
  expect(session.shown(faceId)?.shown).toEqual(before?.shown);
  expect(session.shown(faceId)?.findings).toBe(before?.findings);
  expect(session.shown(faceId)?.runId).toBe(before?.runId);
  expect(waitingIds(app)).not.toContain(before?.runId);
  const page = renderPage(app, faceId);
  expect(page.container.querySelectorAll("[data-glyph]")).toHaveLength(18);
  expect(page.getByRole("button", { name: ADD }).hasAttribute("disabled")).toBe(
    true
  );
  const standing = standingOf(app, faceId);
  if (standing.kind !== "not-offered") {
    throw new Error("The character did not block the extension.");
  }
  expect(
    within(page.getByRole("region", { name: "Add to the face" })).getByText(
      standing.reason
    )
  ).toBeDefined();
  session.add(faceId);
  expect(faceStateOf(session.getState(), faceId).refusal).toBeTruthy();
  expect(project(app).head).toBe(1);
}, 120_000);

it("S5: undo and redo show the same run waiting and then in the face", async () => {
  const { app, faceId } = await open();
  const made = await app.generate({ ...EXTENSION, faceId });
  const session = app.places.screen.scriptExtension();
  session.add(faceId);
  app.workspace.undo();
  expect(session.shown(faceId)?.runId).toBe(made.runId);
  expect(waitingIds(app)).toEqual([made.runId]);
  expect(
    renderPage(app, faceId)
      .getByRole("button", { name: ADD })
      .hasAttribute("disabled")
  ).toBe(false);
  app.workspace.redo();
  expect(session.shown(faceId)?.runId).toBeUndefined();
  expect(standingOf(app, faceId).kind).toBe("in-face");
  expect(app.inspect().waiting.runs).toEqual([]);
}, 120_000);

it("S6: a revision without a run id still shows its extension in the face", async () => {
  const { app, faceId } = await open();
  await app.generate({ ...EXTENSION, faceId });
  const [run] = project(app).runs;
  if (!run) {
    throw new Error("No run was held.");
  }
  expect(app.workspace.apply("Legacy extension", run.changes).ok).toBe(true);
  expect(project(app).revisions[0]?.acceptsRun).toBeUndefined();
  const shown = app.places.screen.scriptExtension().shown(faceId);
  expect(shown?.runId).toBeUndefined();
  expect(standingOf(app, faceId).kind).toBe("in-face");
  expect(shown?.shown.glyphs).toHaveLength(18);
}, 120_000);

it("S7: the page tells absent findings truthfully and keeps its own findings", async () => {
  const { app, faceId } = await open();
  await app.generate({ ...EXTENSION, faceId });
  const outside = renderPage(app, faceId);
  expect(outside.container.querySelectorAll("[data-glyph]")).toHaveLength(18);
  expect(outside.getByRole("button", { name: ADD })).toBeDefined();
  expect(outside.getByText(NO_FINDINGS)).toBeDefined();
  expect(outside.getByText(NO_VERIFICATION)).toBeDefined();
  for (const falsehood of [RECORDED, NO_NOTES, NO_EVALUATION, NO_MAKING]) {
    expect(outside.container.textContent).not.toContain(falsehood);
  }
  expect(outside.queryByRole("heading", { name: "Notes" })).toBeNull();
  expect(
    outside.queryByRole("button", { name: "Build and verify" })
  ).toBeNull();
  expect(outside.container.textContent).not.toContain("Why it was not made");
  cleanup();
  const session = await replay(app, faceId);
  const own = renderPage(app, faceId);
  expect(own.container.querySelectorAll("[data-glyph]")).toHaveLength(18);
  expect(own.getByRole("heading", { name: "Notes" })).toBeDefined();
  expect(own.getByRole("button", { name: "Build and verify" })).toBeDefined();
  expect(own.container.querySelectorAll("[data-verdict]")).toHaveLength(18);
  expect(own.container.textContent).toContain("Made by");
  expect(own.container.textContent).toContain(RECORDED);
  expect(own.container.textContent).not.toContain(NO_FINDINGS);
  expect(own.container.textContent).not.toContain(NO_VERIFICATION);
  const findings = session.shown(faceId)?.findings;
  expect(findings).toBeDefined();
  for (const note of findings?.notes ?? []) {
    expect(own.container.textContent).toContain(note);
  }
}, 120_000);

it("shows no result while a replay is running for the face", async () => {
  const { app, faceId } = await open();
  await app.generate({ ...EXTENSION, faceId });
  const session = app.places.screen.scriptExtension();
  await session.listSource();
  expect(session.shown(faceId)).toBeDefined();
  const running = session.run(faceId);
  try {
    expect(faceStateOf(session.getState(), faceId).run.status).toBe("running");
    expect(session.shown(faceId)).toBeUndefined();
    const page = renderPage(app, faceId);
    expect(page.queryByRole("heading", { name: "Result" })).toBeNull();
    expect(page.queryByRole("button", { name: ADD })).toBeNull();
    expect(page.container.querySelectorAll("[data-glyph]")).toHaveLength(0);
  } finally {
    cleanup();
    await running;
  }
  expect(session.shown(faceId)?.shown.glyphs).toHaveLength(18);
}, 120_000);

it("the four absent findings checks have renderings that contain their strings", async () => {
  const { app, faceId } = await open();
  const session = await replay(app, faceId);
  const displayed = session.shown(faceId);
  if (!displayed?.findings) {
    throw new Error("The page kept no findings from its run.");
  }
  const face = findFace(project(app), faceId);
  // Findings may lack an evaluation, a making description, or notes. These
  // omissions exercise the panels' fallbacks, not the absence of findings.
  const findings = {
    ...displayed.findings,
    glyphs: displayed.findings.glyphs.map((glyph) => ({
      ...glyph,
      evaluation: undefined,
      madeBy: "",
    })),
    notes: [],
  };
  const view = renderInApplication(
    <>
      <ResultBoard
        face={face}
        findings={findings}
        inFace={false}
        shown={displayed.shown}
      />
      <NotesPanel findings={findings} />
    </>,
    app
  );
  for (const sentence of [RECORDED, NO_NOTES, NO_EVALUATION, NO_MAKING]) {
    expect(view.container.textContent).toContain(sentence);
  }
}, 120_000);
