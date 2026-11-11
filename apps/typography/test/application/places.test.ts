/**
 * What the application hands a screen. A screen is taken down whenever a
 * person looks at another place, so it is given one session of each place
 * for as long as the application is open, made with the application's clock
 * and ids. A command is given no session: `use-case-boundary.test.ts` holds
 * that line. The application here is opened the way the browser opens it:
 * its artifacts are kept in memory.
 */
import { describe, expect, it } from "vitest";
import { DEVANAGARI_OFFERING } from "~/generate/script-extension/offering";
import { fetchedRuns } from "~/generation/strategies/recorded/source";
import type { BuiltFont, FontBuilder } from "~/packaging/building";
import { fixtureFetch } from "../generate/helpers/session";
import { testApplication } from "../helpers/application";
import { FIXED_TIME } from "../helpers/fixed";
import { fixtureFile } from "../helpers/workspace";
import { importLato } from "./helpers/project";

/** An id from the application's id source, which counts up from id-1. */
const APPLICATION_ID = /^id-\d+$/;

const BUILT: BuiltFont = {
  bytes: Uint8Array.of(0, 1, 0, 0),
  characterCount: 1,
  glyphCount: 1,
  notes: [],
};

/** A builder whose build finishes only when the test says so. */
const heldBuilder = () => {
  let builds = 0;
  let finish: () => void = () => undefined;
  const build: FontBuilder["build"] = () => {
    builds += 1;
    return new Promise<BuiltFont>((resolve) => {
      finish = () => resolve(BUILT);
    });
  };
  return {
    builder: { build } as FontBuilder,
    builds: () => builds,
    finish: () => finish(),
  };
};

/** Lets the promises a build settled run their handlers. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the sessions a screen is given", () => {
  it("are one for each place, the same one every time the place is opened", async () => {
    const { places } = await testApplication();
    const { screen } = places;
    expect(screen.generate()).toBe(screen.generate());
    expect(screen.family()).toBe(screen.family());
    expect(screen.reconstruct()).toBe(screen.reconstruct());
    expect(screen.scriptExtension()).toBe(screen.scriptExtension());
    expect(screen.scriptExtension().offering).toBe(DEVANAGARI_OFFERING);
  });

  it("belong to one application and no other", async () => {
    const one = await testApplication();
    const other = await testApplication();
    expect(other.places.screen.generate()).not.toBe(
      one.places.screen.generate()
    );
    expect(other.places.export).not.toBe(one.places.export);
    expect(other.places.variable).not.toBe(one.places.variable);
    expect(other.places.proof).not.toBe(one.places.proof);
  });

  it("list the recorded runs the application was opened with", async () => {
    const { places } = await testApplication({
      servedRuns: fetchedRuns("/", fixtureFetch),
    });
    const session = places.screen.generate();
    await session.listRecorded();
    const { catalogue } = session.getState();
    expect(
      catalogue.status === "listed" && catalogue.catalogue.entries.length
    ).toBeGreaterThan(0);
  });

  it("run with the application's clock and ids", async () => {
    const application = await testApplication();
    const { faceId } = await importLato(application);
    const session = application.places.screen.generate();
    await session.run({
      characters: [0xe9],
      faceId,
      kind: "characters",
      strategy: "procedural",
    });
    const [run] = session.getState().runs;
    expect(run?.record).toMatchObject({
      createdAt: FIXED_TIME,
      finishedAt: FIXED_TIME,
      startedAt: FIXED_TIME,
    });
    // The same run of ids the workspace takes its revisions from.
    expect(run?.record.runId).toMatch(APPLICATION_ID);
    expect(run?.id).toMatch(APPLICATION_ID);
  });
});

describe("the provider key", () => {
  const NO_RUN = { available: false, reason: "No recorded run." } as const;

  const canCallModels = (
    options: readonly {
      readonly availability: { readonly available: boolean };
      readonly kind: string;
    }[]
  ) =>
    options
      .filter((option) => option.kind.endsWith("-model"))
      .map((option) => option.availability.available);

  it("starts as the one the application was opened with, for Generate and Reconstruct alike", async () => {
    const { places } = await testApplication({ providerKey: "a-key" });
    expect(places.providerKey.getState()).toBe("a-key");
    expect(
      canCallModels(places.screen.generate().strategyOptions(NO_RUN))
    ).toEqual([true, true]);
    expect(
      canCallModels(places.screen.reconstruct().strategyOptions(NO_RUN))
    ).toEqual([true, true]);
  });

  it("is one key: typed in one place, every place that calls a model has it", async () => {
    const { places } = await testApplication();
    const generate = places.screen.generate();
    const reconstruct = places.screen.reconstruct();
    expect(canCallModels(generate.strategyOptions(NO_RUN))).toEqual([
      false,
      false,
    ]);
    let heard = 0;
    places.providerKey.subscribe(() => {
      heard += 1;
    });
    places.providerKey.setState("typed-key");
    expect(heard).toBe(1);
    expect(canCallModels(generate.strategyOptions(NO_RUN))).toEqual([
      true,
      true,
    ]);
    expect(canCallModels(reconstruct.strategyOptions(NO_RUN))).toEqual([
      true,
      true,
    ]);
  });
});

describe("the working builds of the Proof place", () => {
  it("outlast the Proof screen, so a running build is not started again", async () => {
    const held = heldBuilder();
    const application = await testApplication({ builder: held.builder });
    const { faceId } = await importLato(application);
    // The screen starts a build and is taken down.
    expect(application.places.proof.start(faceId, "Lato Regular")).toBe(true);
    // On the way back the same builds answer: still building, and not restartable.
    const back = application.places.proof;
    expect(back.of(faceId)).toEqual({ status: "building" });
    expect(back.start(faceId, "Lato Regular")).toBe(false);
    expect(held.builds()).toBe(1);
  });

  it("build a face with the application's builder, clock and ids", async () => {
    const held = heldBuilder();
    const application = await testApplication({ builder: held.builder });
    const { faceId } = await importLato(application);
    const { proof } = application.places;
    let heard = 0;
    const stop = proof.subscribe(() => {
      heard += 1;
    });
    proof.start(faceId, "Lato Regular");
    held.finish();
    await settled();
    stop();

    const build = proof.of(faceId);
    expect(heard).toBe(2);
    expect(build).toMatchObject({
      font: {
        builtAt: FIXED_TIME,
        bytes: BUILT.bytes,
        exported: false,
        faceId,
        fileName: "Lato Regular, working face",
      },
      project: application.workspace.getState().project,
      status: "built",
    });
    expect(build.status === "built" && build.font.id).toMatch(APPLICATION_ID);
  });
});

describe("an application whose artifacts are kept in memory", () => {
  it("keeps a font the Import screen imports as an artifact, like one the command line imports", async () => {
    const application = await testApplication();
    const { artifactId, faceId } = await importLato(application);
    expect(artifactId).toBeTruthy();
    expect(application.inspect().faces).toMatchObject([
      { faceId, sourceFont: artifactId },
    ]);
    // The same file again is the same artifact, and is not imported twice.
    const again = await application.import([fixtureFile("lato")]);
    expect(again.fonts).toMatchObject([{ alreadyImported: true, artifactId }]);
    expect(application.workspace.getState().project.sources).toHaveLength(1);
  });
});
