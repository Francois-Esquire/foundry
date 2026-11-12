/**
 * Three facts about a project have one owner each: a candidate's verdict is
 * on the candidate, a run waiting to be accepted whole is in the project
 * with its changes, and a photograph is an artifact the project lists. So
 * what a screen's session makes is there for a command after the project is
 * saved and opened again, and the reverse.
 */
import { describe, expect, it } from "vitest";
import type { Application } from "~/application/application";
import { candidatesWithStatus } from "~/typeface/project";
import { codes } from "../generate/helpers/session";
import { heldLato, MODEL_OUTPUT, PHOTOGRAPH } from "./helpers/held";
import { fixtureAt } from "./helpers/project";
import {
  BANNER,
  BANNER_TEXT,
  closeTwins,
  DEVANAGARI_SUBSET,
  LATIN_HOLDOUT,
  labelOnScreen,
  markOnScreen,
  projectOf,
  STOREFRONT_COMPLETION,
  twins,
} from "./helpers/twins";

const EXTENSION = {
  kind: "script-extension",
  plan: "devanagari-subset",
  recordedRun: DEVANAGARI_SUBSET,
} as const;

const LABEL = "Add a Devanagari subset";

/** Replays the script extension for a face through the screen's session. */
const runOnScreen = async (app: Application, faceId: string) => {
  const session = app.places.screen.scriptExtension();
  await session.listSource();
  await session.run(faceId);
  return session;
};

const waitingRuns = (app: Application) => app.inspect().waiting.runs;
const headOf = (app: Application) => app.workspace.getState().project.head;
const lastLabel = (app: Application) => {
  const { head, revisions } = app.workspace.getState().project;
  return revisions[head - 1]?.label;
};

describe("B2: a screen's run is a command's run", () => {
  it("a run made on screen waits for a command after a reopening, and is accepted whole", async () => {
    const { app, faceId, reopen } = await heldLato();
    await runOnScreen(app, faceId);
    const later = await reopen(app);
    const [run, ...others] = waitingRuns(later);
    expect(others).toEqual([]);
    expect(run).toMatchObject({ faceId, glyphs: 18, script: "Devanagari" });
    expect(run?.modelOutput).toBeTruthy();
    const accepted = await later.accept({ run: run?.runId ?? "" });
    expect(accepted).toEqual({ accepted: 18, revisions: 1 });
    expect(lastLabel(later)).toBe(LABEL);
    expect(waitingRuns(later)).toEqual([]);
    await later.close();
  });

  it("a run made by command is waiting in the screen's session, which can add it", async () => {
    const { app, faceId, reopen } = await heldLato();
    const made = await app.generate({ ...EXTENSION, faceId });
    const later = await reopen(app);
    const session = later.places.screen.scriptExtension();
    expect(session.waitingRun(faceId)).toMatchObject({
      faceId,
      glyphs: 18,
      runId: made.runId,
    });
    session.add(faceId);
    expect(headOf(later)).toBe(1);
    expect(lastLabel(later)).toBe(LABEL);
    expect(session.waitingRun(faceId)).toBeUndefined();
    expect(waitingRuns(later)).toEqual([]);
    await later.close();
  });
});

describe("B3: a screen's verdicts are a command's verdicts", () => {
  /** A project with three candidates made by rule and six replayed, all through the session. */
  const generated = async () => {
    const held = await heldLato();
    const session = held.app.places.screen.generate();
    await session.run({
      characters: codes("éèñ"),
      faceId: held.faceId,
      kind: "characters",
      strategy: "procedural",
    });
    await session.listRecorded();
    await session.run({
      entryId: `${LATIN_HOLDOUT}#image-model`,
      faceId: held.faceId,
      kind: "recorded",
    });
    return { ...held, session };
  };

  const acceptedIds = (app: Application) =>
    candidatesWithStatus(app.workspace.getState().project, "accepted").map(
      ({ id }) => id
    );

  it("accept passed, by command after a reopening, accepts what the session's own would", async () => {
    const onScreen = await generated();
    for (const run of onScreen.session.getState().runs) {
      onScreen.session.acceptPassed(run.id);
    }
    const byCommand = await generated();
    const later = await byCommand.reopen(byCommand.app);
    const waiting = later.inspect().waiting.candidates;
    expect(waiting).toHaveLength(9);
    expect(waiting.map((candidate) => candidate.verdict).sort()).toEqual([
      ...Array.from({ length: 3 }, () => "pass"),
      ...Array.from({ length: 6 }, () => "review"),
    ]);
    const accepted = await later.accept({ candidates: "passed" });
    expect(accepted).toEqual({ accepted: 3, revisions: 3 });
    expect(acceptedIds(later)).toHaveLength(3);
    expect(acceptedIds(later)).toEqual(acceptedIds(onScreen.app));
    await onScreen.app.close();
    await later.close();
  });
});

describe("B4: undo brings a run back", () => {
  it("on screen: added, undone, waiting again, added again, and not waiting once redone", async () => {
    const { app, faceId } = await heldLato();
    const session = await runOnScreen(app, faceId);
    const [run] = waitingRuns(app);
    expect(run).toBeDefined();
    session.add(faceId);
    expect(waitingRuns(app)).toEqual([]);

    app.workspace.undo();
    expect(waitingRuns(app)).toEqual([run]);
    expect(session.waitingRun(faceId)?.runId).toBe(run?.runId);
    session.add(faceId);
    expect(headOf(app)).toBe(1);
    expect(waitingRuns(app)).toEqual([]);

    app.workspace.undo();
    expect(waitingRuns(app)).toEqual([run]);
    app.workspace.redo();
    expect(waitingRuns(app)).toEqual([]);
    await app.close();
  });

  it("by command: accepted, undone, waiting again, accepted again, and not waiting once redone", async () => {
    const { app, faceId } = await heldLato();
    const { runId } = await app.generate({ ...EXTENSION, faceId });
    const [run] = waitingRuns(app);
    expect(run?.runId).toBe(runId);
    expect(await app.accept({ run: runId })).toEqual({
      accepted: 18,
      revisions: 1,
    });
    expect(waitingRuns(app)).toEqual([]);

    app.workspace.undo();
    expect(waitingRuns(app)).toEqual([run]);
    expect(await app.accept({ run: runId })).toEqual({
      accepted: 18,
      revisions: 1,
    });
    expect(waitingRuns(app)).toEqual([]);

    app.workspace.undo();
    expect(waitingRuns(app)).toEqual([run]);
    app.workspace.redo();
    expect(waitingRuns(app)).toEqual([]);
    await app.close();
  });
});

describe("B6: a photograph opened on screen is an artifact", () => {
  it("is listed, is one artifact however often it is opened, and is there for a command after a reopening", async () => {
    const { app, faceId, idsOf, reopen } = await heldLato();
    const photograph = fixtureAt("evidence/storefront-needed-things.jpg");
    const file = { bytes: photograph.bytes, fileName: photograph.name };
    const session = app.places.screen.reconstruct();
    await session.openEvidence(file);
    const digest = session.getState().evidence?.id;
    expect(digest).toBeTruthy();
    const listed = [
      { artifactId: `photograph-${digest}`, fileName: photograph.name },
    ];
    expect(app.inspect().photographs).toEqual(listed);

    await session.openEvidence(file);
    expect(app.inspect().photographs).toEqual(listed);
    expect(await idsOf(PHOTOGRAPH)).toEqual([`photograph-${digest}`]);
    // Importing the same file by command finds the one the screen kept.
    const again = await app.import([photograph]);
    expect(again.photographs).toEqual([
      {
        alreadyImported: true,
        artifactId: `photograph-${digest}`,
        fileName: photograph.name,
      },
    ]);

    const later = await reopen(app);
    expect(later.inspect().photographs).toEqual(listed);
    const recovered = await later.reconstruct({
      destination: { faceId, kind: "existing" },
      photograph: `photograph-${digest}`,
      region: BANNER,
      text: BANNER_TEXT,
    });
    expect(recovered.observed.length).toBeGreaterThan(8);
    await later.close();
  });

  it("lists nothing for a file that is not a picture, on screen or by command, and says the same of it", async () => {
    const { app, idsOf } = await heldLato();
    const bytes = new TextEncoder().encode("not a picture");
    const session = app.places.screen.reconstruct();
    await session.openEvidence({ bytes, fileName: "notes.png" });
    const imported = await app.import([{ bytes, name: "notes.png" }]);
    expect(imported.refused).toEqual([
      { name: "notes.png", reason: session.getState().evidenceProblem },
    ]);
    expect(session.getState().evidenceProblem).toBeTruthy();
    expect(app.inspect().photographs).toEqual([]);
    expect(await idsOf(PHOTOGRAPH)).toEqual([]);
    await app.close();
  });
});

describe("B9: model output is kept however the run was made", () => {
  it("a script extension replayed on screen leaves the artifact a command's replay leaves", async () => {
    const screen = await heldLato();
    const command = await heldLato();
    await runOnScreen(screen.app, screen.faceId);
    const made = await command.app.generate({
      ...EXTENSION,
      faceId: command.faceId,
    });
    expect(made.modelOutput).toBeTruthy();
    expect(waitingRuns(screen.app)[0]?.modelOutput).toBe(made.modelOutput);
    expect(await screen.idsOf(MODEL_OUTPUT)).toEqual([made.modelOutput]);
    expect(await command.idsOf(MODEL_OUTPUT)).toEqual([made.modelOutput]);
    await screen.app.close();
    await command.app.close();
  });

  it("a recorded run of candidates replayed on screen leaves the artifact a command's replay leaves", async () => {
    const screen = await heldLato();
    const command = await heldLato();
    const session = screen.app.places.screen.generate();
    await session.listRecorded();
    await session.run({
      entryId: `${LATIN_HOLDOUT}#vector-model`,
      faceId: screen.faceId,
      kind: "recorded",
    });
    const made = await command.app.generate({
      faceId: command.faceId,
      kind: "recorded",
      output: "vector-model",
      recordedRun: LATIN_HOLDOUT,
    });
    expect(made.modelOutput).toBeTruthy();
    expect(await screen.idsOf(MODEL_OUTPUT)).toEqual([made.modelOutput]);
    expect(await command.idsOf(MODEL_OUTPUT)).toEqual([made.modelOutput]);
    await screen.app.close();
    await command.app.close();
  });

  it("an alphabet completed from a recorded run on screen leaves the artifact a command's leaves", async () => {
    const photograph = fixtureAt("evidence/storefront-needed-things.jpg");
    const screen = await heldLato();
    const command = await heldLato();
    const session = screen.app.places.screen.reconstruct();
    await markOnScreen(
      session,
      {
        app: screen.app,
        faceId: screen.faceId,
        photograph: {
          artifactId: "",
          bytes: photograph.bytes,
          fileName: photograph.name,
        },
      },
      BANNER
    );
    await labelOnScreen(session, BANNER_TEXT);
    session.setDestination({ faceId: screen.faceId, kind: "existing" });
    await session.propose();
    session.updateCompletionDraft({ strategy: "recorded-run" });
    await session.listRecorded();
    await session.complete();
    const [imported] = (await command.app.import([photograph])).photographs;
    const made = await command.app.reconstruct({
      complete: { kind: "recorded", recordedRun: STOREFRONT_COMPLETION },
      destination: { faceId: command.faceId, kind: "existing" },
      photograph: imported?.artifactId ?? "",
      region: BANNER,
      text: BANNER_TEXT,
    });
    expect(made.modelOutput).toBeTruthy();
    expect(await screen.idsOf(MODEL_OUTPUT)).toEqual([made.modelOutput]);
    expect(await command.idsOf(MODEL_OUTPUT)).toEqual([made.modelOutput]);
    await screen.app.close();
    await command.app.close();
  });
});

describe("a screen and a command draw the same ids", () => {
  it("so the same steps leave the same project after generating by rule and accepting what passed", async () => {
    const pair = await twins();
    const { command, screen } = pair;
    const session = screen.app.places.screen.generate();
    await session.run({
      characters: codes("éèñ"),
      faceId: screen.faceId,
      kind: "characters",
      strategy: "procedural",
    });
    const [run] = session.getState().runs;
    session.acceptPassed(run?.id ?? "");
    await command.app.generate({
      characters: "é è U+00F1",
      faceId: command.faceId,
      kind: "characters",
      strategy: "procedural",
    });
    await command.app.accept({ candidates: "passed" });
    expect(projectOf(screen).head).toBe(3);
    expect(projectOf(screen)).toEqual(projectOf(command));
    await closeTwins(pair);
  });
});
