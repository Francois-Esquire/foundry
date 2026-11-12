/**
 * Where the use cases live and who may reach what. A command is the places'
 * operations in order, so no command touches a session. A session is made
 * for a screen and nowhere else. An operation is a plain module, with no
 * session and no React behind it. Recorded runs come from a source, never
 * from a stand-in for a web server.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testApplication } from "../helpers/application";
import { heldLato } from "./helpers/held";
import {
  importsOf,
  modulesUnder,
  named,
  reach,
  relative,
  SRC,
} from "./helpers/imports";
import { DEVANAGARI_SUBSET } from "./helpers/twins";

const PLACES = "src/application/places.ts";

/** The plain modules that hold each place's operations. */
const OPERATIONS = [
  "src/generation/strategies/recorded/source.ts",
  "src/generation/strategies/recorded/catalogue.ts",
  "src/generate/running.ts",
  "src/generate/script-extension/extending.ts",
  "src/reconstruct/reading.ts",
  "src/reconstruct/proposing.ts",
  "src/reconstruct/completing.ts",
];

const SESSION_MODULE = /(?:^|[/-])session\.ts$/;
const everyModule = modulesUnder(".");
const sessionModules = everyModule.filter((file) => SESSION_MODULE.test(file));
const applicationModules = modulesUnder("application");
const pathOf = (name: string) => path.join(SRC, name.slice("src/".length));

describe("I1: a command is not a session's driver", () => {
  it("finds the session modules it guards against", () => {
    expect(relative(sessionModules)).toEqual(
      expect.arrayContaining([
        "src/export/session.ts",
        "src/export/variable/variable-session.ts",
        "src/generate/family/family-session.ts",
        "src/generate/script-extension/session.ts",
        "src/generate/session.ts",
        "src/reconstruct/session.ts",
      ])
    );
  });

  it("no module of the application but places.ts imports a session module", () => {
    const importers = applicationModules
      .filter((file) => named(file) !== PLACES)
      .flatMap((file) =>
        importsOf(file)
          .files.filter((imported) => sessionModules.includes(imported))
          .map((imported) => `${named(file)} imports ${named(imported)}`)
      );
    expect(importers).toEqual([]);
  });

  it("a command leaves every screen's session as it was made", async () => {
    const { app, faceId } = await heldLato();
    try {
      const { screen } = app.places;
      const made = {
        generate: screen.generate().getState(),
        reconstruct: screen.reconstruct().getState(),
        scriptExtension: screen.scriptExtension().getState(),
      };
      const run = await app.generate({
        faceId,
        kind: "script-extension",
        plan: "devanagari-subset",
        recordedRun: DEVANAGARI_SUBSET,
      });
      await app.accept({ run: run.runId });
      await app.generate({
        characters: "é è",
        faceId,
        kind: "characters",
        strategy: "procedural",
      });
      await app.accept({ candidates: "all" });
      expect(app.workspace.getState().project.revisions).toHaveLength(3);
      expect(screen.generate().getState()).toEqual(made.generate);
      expect(screen.reconstruct().getState()).toEqual(made.reconstruct);
      expect(screen.scriptExtension().getState()).toEqual(made.scriptExtension);
    } finally {
      await app.close();
    }
  });
});

describe("I2: the places have one rule", () => {
  it("hold what a screen keeps and what the open project shares, and nothing for a command", async () => {
    const { close, places } = await testApplication();
    expect(Object.keys(places).sort()).toEqual([
      "export",
      "layoutSummary",
      "proof",
      "providerKey",
      "screen",
      "variable",
    ]);
    expect(Object.keys(places.screen).sort()).toEqual([
      "family",
      "generate",
      "reconstruct",
      "scriptExtension",
    ]);
    // Nothing at the top is a factory: a session is kept, never made on request.
    expect(
      Object.entries(places)
        .filter(([, member]) => typeof member === "function")
        .map(([name]) => name)
    ).toEqual([]);
    await close();
  });
});

describe("I4: an operation is a plain module", () => {
  it.each(OPERATIONS)("%s exists", (name) => {
    expect(existsSync(pathOf(name))).toBe(true);
  });

  it.each(OPERATIONS)("%s reaches no session and no React", (name) => {
    const file = pathOf(name);
    expect(existsSync(file)).toBe(true);
    const { files, packages } = reach(file);
    expect(
      relative(files).filter((reached) => SESSION_MODULE.test(reached))
    ).toEqual([]);
    expect(
      relative(files).filter((reached) => reached.endsWith(".tsx"))
    ).toEqual([]);
    expect([...packages].filter((used) => used.startsWith("react"))).toEqual(
      []
    );
  });
});
