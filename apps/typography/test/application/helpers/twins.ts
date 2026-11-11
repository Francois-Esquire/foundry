/**
 * Two applications that are alike in every means, for comparing what a
 * screen's session leaves in a project with what a command leaves there. Both
 * have the fixed clock, ids that count up from id-1, the real reader, codec
 * and font engine, and the same recorded runs: served for a screen, and
 * found by name for a command.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Application } from "~/application/application";
import type { ApplicationMeans } from "~/application/means";
import { fetchedRuns, filesRun } from "~/generation/strategies/recorded/source";
import { Refusal } from "~/lib/refusal";
import type { FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { rectangle } from "~/reconstruct/core";
import { letterKey } from "~/reconstruct/reading";
import type { ReconstructSession } from "~/reconstruct/session";
import { labelFromText } from "~/reconstruction/recognition/recognizer";
import { fixtureFetch } from "../../generate/helpers/session";
import { testApplication } from "../../helpers/application";
import { fixtureAt } from "./project";

const RUNS = path.join(import.meta.dirname, "../../fixtures/generation");

export const LATIN_HOLDOUT = "2026-11-10-latin-holdout";
export const DEVANAGARI_SUBSET = "2026-11-10-devanagari-subset";
export const STOREFRONT_COMPLETION = "2026-11-10-storefront-completion";
const STOREFRONT = "evidence/storefront-needed-things.jpg";

/** The lettering of the storefront banner, in the photograph's pixels. */
export const BANNER = { height: 196, width: 400, x: 432, y: 162 };
export const BANNER_TEXT = ["NEEDED THINGS", "FOR SALE"];
/** One pixel of the photograph: no letter is found there. */
export const ONE_PIXEL = { height: 1, width: 1, x: 10, y: 10 };

/** The real font engine, started only by a case that makes a new face. */
const builder = {
  blankFont: async (request) => (await nodeFontBuilder()).blankFont(request),
} as FontBuilder;

/** Every file of a fixture run, by name. None when there is no such run. */
const runFiles = (name: string): ReadonlyMap<string, Uint8Array> => {
  const directory = path.join(RUNS, name);
  return new Map(
    existsSync(directory)
      ? readdirSync(directory).map((file) => [
          file,
          new Uint8Array(readFileSync(path.join(directory, file))),
        ])
      : []
  );
};

/**
 * One application: the fixture runs served, and each found by its name.
 * `means` replaces any of its means, such as a network that is down.
 */
const open = (means: Partial<ApplicationMeans>) =>
  testApplication({
    builder,
    runAt: (name) => Promise.resolve(filesRun(name, runFiles(name))),
    servedRuns: fetchedRuns("/", fixtureFetch),
    ...means,
  });

/**
 * One application whose only recorded run is the script extension's, held
 * with none of its files: the run a screen and a command both ask for is not
 * there.
 */
const openWithoutTheRun = () => {
  const held = filesRun(DEVANAGARI_SUBSET, new Map());
  return testApplication({
    builder,
    runAt: () => Promise.resolve(held),
    servedRuns: held,
  });
};

export interface Twin {
  readonly app: Application;
  readonly faceId: string;
  /** The storefront photograph's artifact, and its bytes for a screen to open. */
  readonly photograph: {
    readonly artifactId: string;
    readonly bytes: Uint8Array;
    readonly fileName: string;
  };
}

const twinOf = async (app: Application): Promise<Twin> => {
  const photograph = fixtureAt(STOREFRONT);
  const imported = await app.import([
    fixtureAt("fonts/Lato-Regular.ttf"),
    photograph,
  ]);
  const faceId = imported.fonts[0]?.faces[0]?.faceId;
  const artifactId = imported.photographs[0]?.artifactId;
  if (!(faceId && artifactId)) {
    throw new Error("The twin's font and photograph were not imported.");
  }
  return {
    app,
    faceId,
    photograph: {
      artifactId,
      bytes: photograph.bytes,
      fileName: photograph.name,
    },
  };
};

/**
 * A pair of applications holding Lato and the storefront photograph, each
 * imported by the same command, so both projects start deep-equal.
 */
export const twins = async (
  means: Partial<ApplicationMeans> = {}
): Promise<{
  readonly command: Twin;
  readonly screen: Twin;
}> => ({
  command: await twinOf(await open(means)),
  screen: await twinOf(await open(means)),
});

/** The same pair, over the recorded run that is not there. */
export const twinsWithoutTheRun = async (): Promise<{
  readonly command: Twin;
  readonly screen: Twin;
}> => ({
  command: await twinOf(await openWithoutTheRun()),
  screen: await twinOf(await openWithoutTheRun()),
});

export const closeTwins = async (pair: {
  readonly command: Twin;
  readonly screen: Twin;
}) => {
  await pair.command.app.close();
  await pair.screen.app.close();
};

/** The project an application holds now. */
export const projectOf = ({ app }: Twin) => app.workspace.getState().project;

/** A screen's session reads a region after the screen has drawn: this waits for that. */
const drawn = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** Opens the photograph in a screen's session and marks a region, as a person does. */
export const markOnScreen = async (
  session: ReconstructSession,
  { photograph }: Twin,
  region: typeof BANNER
) => {
  await session.openEvidence({
    bytes: photograph.bytes,
    fileName: photograph.fileName,
  });
  session.markRegion(
    rectangle(region.x, region.y, region.width, region.height)
  );
  await drawn();
};

/** Labels every letter a screen's session found from the text, one label at a time. */
export const labelOnScreen = async (
  session: ReconstructSession,
  text: readonly string[]
) => {
  const found = session.getState().reading?.readings ?? [];
  for (const reading of labelFromText(found, text)) {
    session.label(letterKey(reading), reading.character);
  }
  await drawn();
};

/** The sentence a command refused with. Fails when it did not refuse. */
export const refusalOf = async (command: Promise<unknown>): Promise<string> => {
  const outcome = await command.then(
    () => undefined,
    (error: unknown) => error
  );
  if (!(outcome instanceof Refusal)) {
    throw new Error(
      `The command did not refuse: ${outcome instanceof Error ? outcome.message : "it went ahead"}.`
    );
  }
  return outcome.message;
};
