import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Application } from "~/application/application";
import { AddPanel } from "~/generate/script-extension/add-panel";
import { ExtensionRunPanel } from "~/generate/script-extension/extension-run-panel";
import {
  EXTENSION_IN_FACE,
  faceStanding,
} from "~/generate/script-extension/face-standing";
import { faceStateOf } from "~/generate/script-extension/session";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import { findFace } from "~/typeface/project";
import { heldLato } from "./helpers/held";
import { DEVANAGARI_SUBSET, refusalOf } from "./helpers/twins";

const extension = {
  kind: "script-extension",
  plan: "devanagari-subset",
  recordedRun: DEVANAGARI_SUBSET,
} as const;
const standing = (app: Application, faceId: string) =>
  faceStanding({
    face: findFace(app.workspace.getState().project, faceId),
    inSource: () => false,
    plan,
    project: app.workspace.getState().project,
  });

describe("C3: an extension survives reopening", () => {
  it("refuses without holding work and permits a fresh run after undo", async () => {
    const held = await heldLato();
    const other = await heldLato();
    let command = other.app;
    let { app } = held;
    const { faceId } = held;
    const session = app.places.screen.scriptExtension();
    await session.listSource();
    await session.run(faceId);
    session.add(faceId);
    const first = await command.generate({
      ...extension,
      faceId: other.faceId,
    });
    await command.accept({ run: first.runId });
    app = await held.reopen(app);
    command = await other.reopen(command);
    try {
      const { project } = app.workspace.getState();
      const inspection = app.inspect();
      const commandProject = command.workspace.getState().project;
      const commandInspection = command.inspect();
      const later = app.places.screen.scriptExtension();
      await later.listSource();
      const before = faceStateOf(later.getState(), faceId).run;
      expect(standing(app, faceId).kind).toBe("in-face");
      expect(EXTENSION_IN_FACE).toBe(
        "The extension is in the face. Undo it to run again."
      );
      expect(
        renderToStaticMarkup(
          createElement(ExtensionRunPanel, {
            face: findFace(project, faceId),
            onListAgain: async () => undefined,
            onRun: () => undefined,
            run: before,
            source: later.getState().source,
            standing: standing(app, faceId),
          })
        )
      ).toContain(EXTENSION_IN_FACE);
      await later.run(faceId);
      expect(faceStateOf(later.getState(), faceId).run).toEqual(before);
      expect(
        await refusalOf(
          command.generate({ ...extension, faceId: other.faceId })
        )
      ).toBe("The extension is in the face. Undo it to run again.");
      expect(app.workspace.getState().project).toEqual(project);
      expect(app.inspect()).toEqual(inspection);
      expect(command.workspace.getState().project).toEqual(commandProject);
      expect(command.inspect()).toEqual(commandInspection);
      expect(app.workspace.getState().project).toEqual(
        command.workspace.getState().project
      );
      app.workspace.undo();
      command.workspace.undo();
      await later.run(faceId);
      const retry = await command.generate({
        ...extension,
        faceId: other.faceId,
      });
      expect(app.workspace.getState().project.runs).toHaveLength(
        project.runs.length + 1
      );
      expect(command.workspace.getState().project.runs).toHaveLength(
        commandProject.runs.length + 1
      );
      later.add(faceId);
      await command.accept({ run: retry.runId });
      expect(app.workspace.getState().project).toEqual(
        command.workspace.getState().project
      );
      expect(standing(app, faceId).kind).toBe("in-face");
    } finally {
      await app.close();
      await command.close();
    }
  });
});

describe("C4: one page", () => {
  it("reads the earlier extension after undo, replay and redo", async () => {
    const { app, faceId } = await heldLato();
    try {
      const session = app.places.screen.scriptExtension();
      await session.listSource();
      await session.run(faceId);
      session.add(faceId);
      app.workspace.undo();
      await session.run(faceId);
      app.workspace.redo();
      expect(standing(app, faceId).kind).toBe("in-face");
      const { project } = app.workspace.getState();
      const shown = session.shown(faceId)?.shown;
      if (!shown) {
        throw new Error("The session has no shown extension.");
      }
      expect(
        renderToStaticMarkup(
          createElement(AddPanel, {
            face: findFace(project, faceId),
            onAdd: () => undefined,
            refusal: undefined,
            shown,
            standing: standing(app, faceId),
          })
        )
      ).toContain('disabled=""');
      session.add(faceId);
      expect(app.workspace.getState().project).toEqual(project);
    } finally {
      await app.close();
    }
  });

  it("adds the page's run when a command has held a newer run", async () => {
    const { app, faceId } = await heldLato();
    try {
      const session = app.places.screen.scriptExtension();
      await session.listSource();
      await session.run(faceId);
      const [shown] = app.workspace.getState().project.runs;
      await app.generate({ ...extension, faceId });
      session.add(faceId);
      expect(app.workspace.getState().project.revisions[0]?.acceptsRun).toBe(
        shown?.runId
      );
      expect(app.workspace.getState().project.runs).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});
