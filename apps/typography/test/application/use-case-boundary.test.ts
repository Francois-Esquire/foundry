/**
 * Where the use cases live and who may reach what. A command is the places'
 * operations in order, so no command touches a session. A session is made
 * for a screen and nowhere else. An operation is a plain module, with no
 * session and no React behind it. Recorded runs come from a source, never
 * from a stand-in for a web server.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testApplication } from "../helpers/application";
import {
  importsOf,
  modulesUnder,
  named,
  reach,
  relative,
  SRC,
} from "./helpers/imports";

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
const MAKES_A_SESSION = /\bcreate\w+Session\(/;
const BUILDS_A_RESPONSE = /\bnew Response\(|\bResponse\.\w+\(/;
const FETCH_OR_BASE = /\breadonly (?:base|fetch)\??:/;
/** A session the application holds, as a command would reach it. */
const HELD_SESSION = /\bplaces\s*\.\s*(?:screen|export|variable|proof)\b/;
/** What a command said when it read a session's state and found no result. */
const READ_BACK = [
  "did not start",
  "could not be listed",
  "were not asked for",
  "were not proposed",
  "The region could not be read.",
];

const everyModule = modulesUnder(".");
const sessionModules = everyModule.filter((file) => SESSION_MODULE.test(file));
const applicationModules = modulesUnder("application");
const textOf = (file: string) => readFileSync(file, "utf8");
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

  it("no module of the application reaches a session the places hold", () => {
    expect(
      relative(
        applicationModules.filter((file) => HELD_SESSION.test(textOf(file)))
      )
    ).toEqual([]);
  });

  it("only places.ts makes a session", () => {
    const makers = everyModule.filter((file) =>
      MAKES_A_SESSION.test(textOf(file))
    );
    expect(relative(makers)).toEqual([PLACES]);
  });
});

describe("I2: the places have one rule", () => {
  it("hold what a screen keeps and what the open project shares, and nothing for a command", async () => {
    const { close, places } = await testApplication();
    expect(Object.keys(places).sort()).toEqual([
      "export",
      "proof",
      "providerKey",
      "screen",
      "studio",
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

  it("schedule nothing on a command's behalf", () => {
    expect(textOf(pathOf(PLACES))).not.toContain("defer");
  });
});

describe("I3: recorded runs do not come through a stand-in web server", () => {
  it("nothing in the application builds a Response", () => {
    expect(
      relative(
        applicationModules.filter((file) =>
          BUILDS_A_RESPONSE.test(textOf(file))
        )
      )
    ).toEqual([]);
  });

  it("no session's means holds a fetch or a base, in its own module or in the operations it extends", () => {
    expect(
      relative(
        [...sessionModules, ...OPERATIONS.map(pathOf)].filter((file) =>
          FETCH_OR_BASE.test(textOf(file))
        )
      )
    ).toEqual([]);
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

describe("I6: no sentence is a command's alone", () => {
  it("the application has no sentence for a step whose result it could not read back", () => {
    const found = applicationModules.flatMap((file) =>
      READ_BACK.filter((sentence) => textOf(file).includes(sentence)).map(
        (sentence) => `${named(file)}: ${sentence}`
      )
    );
    expect(found).toEqual([]);
  });
});
