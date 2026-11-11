/**
 * How the app's things are kept as artifacts.
 *
 * The cases are one sequence. They run in order on one project, and each
 * starts from what the case before it left.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Application } from "~/application/application";
import {
  fixtureAt,
  found,
  importLato,
  recordedRun,
  tempProject,
} from "./helpers/project";

const TYPES = {
  export: "application/vnd.foundry.typography.derived-font",
  modelOutput: "application/vnd.foundry.typography.model-output",
  photograph: "application/vnd.foundry.typography.photograph",
  project: "application/vnd.foundry.typography.project",
  sourceFont: "application/vnd.foundry.typography.source-font",
} as const;

describe("the artifacts of a project", () => {
  const { artifacts, open, remove, reopen } = tempProject();
  let app: Application;
  let faceId = "";
  const ofType = async (type: string) =>
    (await artifacts().list({ type })).items;

  beforeAll(async () => {
    app = await open();
    ({ faceId } = await importLato(app));
  });

  afterAll(async () => {
    await app.close();
    remove();
  });

  it("keeps an imported font byte for byte, frozen, and the same file twice as one artifact", async () => {
    const lato = fixtureAt("fonts/Lato-Regular.ttf");
    const again = await app.import([{ ...lato, name: "Lato-Copy.ttf" }]);
    const [font] = again.fonts;
    expect(font?.alreadyImported).toBe(true);
    const fonts = await ofType(TYPES.sourceFont);
    expect(fonts).toHaveLength(1);
    expect(fonts[0]?.id).toBe(font?.artifactId);
    expect(fonts[0]?.content?.state).toBe("frozen");
    const kept = await artifacts().readRoot(found(fonts[0]?.content).id);
    expect(kept?.blob).toEqual(lato.bytes);
    // A new application on the same directory finds the same artifact too.
    app = await reopen(app);
    const third = await app.import([lato]);
    expect(third.fonts[0]?.artifactId).toBe(font?.artifactId);
    expect(await ofType(TYPES.sourceFont)).toHaveLength(1);
  });

  it("keeps a photograph once, frozen, and refuses a picture it cannot read", async () => {
    const photograph = fixtureAt("evidence/storefront-needed-things.jpg");
    const first = await app.import([photograph]);
    const second = await app.import([
      photograph,
      { bytes: new TextEncoder().encode("not a picture"), name: "notes.png" },
    ]);
    expect(first.photographs[0]?.alreadyImported).toBe(false);
    expect(second.photographs[0]).toMatchObject({
      alreadyImported: true,
      artifactId: first.photographs[0]?.artifactId,
    });
    expect(second.refused).toEqual([
      expect.objectContaining({ name: "notes.png" }),
    ]);
    const kept = await ofType(TYPES.photograph);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.content?.state).toBe("frozen");
    expect(app.inspect().photographs).toEqual([
      {
        artifactId: first.photographs[0]?.artifactId,
        fileName: "storefront-needed-things.jpg",
      },
    ]);
  });

  it("keeps replayed model output as one frozen artifact in the recorded-run format", async () => {
    const request = {
      faceId,
      kind: "recorded",
      output: "vector-model",
      recordedRun: recordedRun("2026-11-10-latin-holdout"),
    } as const;
    const first = await app.generate(request);
    const second = await app.generate({ ...request, output: "image-model" });
    expect(second.modelOutput).toBe(first.modelOutput);
    const [output] = await ofType(TYPES.modelOutput);
    expect(await ofType(TYPES.modelOutput)).toHaveLength(1);
    expect(output?.content?.state).toBe("frozen");
    expect(Object.keys(output?.content?.tree ?? {})).toEqual(
      expect.arrayContaining([
        "run.json",
        "ideogram-vector-medium.svg",
        "gpt-image-2.6-low.png",
        "prompt-vector-sheet.txt",
      ])
    );
  });

  it("keeps a waiting run's change set with its model output", async () => {
    const run = await app.generate({
      faceId,
      kind: "script-extension",
      plan: "devanagari-subset",
      recordedRun: recordedRun("2026-11-10-devanagari-subset"),
    });
    const outputs = await ofType(TYPES.modelOutput);
    const kept = outputs.find((artifact) => artifact.id === run.modelOutput);
    expect(kept?.content?.state).toBe("frozen");
    expect(Object.keys(kept?.content?.tree ?? {})).toEqual(
      expect.arrayContaining(["run.json", "change-set.json"])
    );
  });

  it("writes the project file in place: one artifact, one Content, however often it is saved", async () => {
    await app.save();
    await app.save();
    app = await reopen(app);
    const [project, ...others] = await ofType(TYPES.project);
    expect(others).toEqual([]);
    expect(project?.content?.state).toBe("ready");
    expect(await artifacts().listContents(found(project).id)).toHaveLength(1);
    expect(Object.keys(project?.content?.tree ?? {})).toEqual(["project.json"]);
  });

  it("keeps every export of a file name as a new frozen Content of one artifact", async () => {
    const request = { faces: [faceId], familyName: "Atlas Sans" };
    const first = await app.export(request);
    const second = await app.export(request);
    const other = await app.export({ ...request, familyName: "Atlas Serif" });
    const [one] = first.fonts;
    const [two] = second.fonts;
    expect(two?.ref.artifactId).toBe(one?.ref.artifactId);
    expect(other.fonts[0]?.ref.artifactId).not.toBe(one?.ref.artifactId);
    const kept = await ofType(TYPES.export);
    expect(kept.map((artifact) => artifact.name).sort()).toEqual([
      "AtlasSans-Regular.ttf",
      "AtlasSerif-Regular.ttf",
    ]);
    const contents = await artifacts().listContents(
      found(kept.find((artifact) => artifact.id === one?.ref.artifactId)).id
    );
    expect(contents.map((content) => content.state)).toEqual([
      "frozen",
      "frozen",
    ]);
    expect(contents.map((content) => content.id)).toEqual([
      one?.ref.contentId,
      two?.ref.contentId,
    ]);
    // Each version holds the font and what was checked in it.
    const checks = await artifacts().readFile(
      found(contents[0]).id,
      "checks.json"
    );
    const report = JSON.parse(new TextDecoder().decode(checks?.blob)) as {
      readonly checks: readonly {
        readonly id: string;
        readonly outcome: string;
      }[];
    };
    expect(report.checks.find((check) => check.id === "browser")?.outcome).toBe(
      "not-run"
    );
    expect(app.inspect().exports).toEqual([
      expect.objectContaining({
        fileName: "AtlasSans-Regular.ttf",
        versions: 2,
      }),
      expect.objectContaining({
        fileName: "AtlasSerif-Regular.ttf",
        versions: 1,
      }),
    ]);
    // A third export of the first name, then a reopening: the list reads the same.
    await app.export(request);
    const listed = app.inspect().exports;
    expect(listed.map((entry) => [entry.fileName, entry.versions])).toEqual([
      ["AtlasSans-Regular.ttf", 3],
      ["AtlasSerif-Regular.ttf", 1],
    ]);
    app = await reopen(app);
    expect(app.inspect().exports).toEqual(listed);
    // An earlier version can still be rendered by naming it.
    const earlier = await app.render({
      font: {
        artifactId: one?.ref.artifactId ?? "",
        contentId: one?.ref.contentId,
      },
      text: "Atlas",
    });
    expect(earlier.missing).toEqual([]);
  });

  it("passes an unchanged face through as its source file, and builds nothing", async () => {
    const {
      artifacts: store,
      open: openOther,
      remove: removeOther,
    } = tempProject();
    const other = await openOther();
    const lato = await importLato(other);
    const exported = await other.export({ faces: [lato.faceId] });
    expect(exported.fonts).toEqual([
      expect.objectContaining({
        checks: [],
        fileName: "Lato-Regular.ttf",
        kind: "original",
        ref: { artifactId: lato.artifactId },
      }),
    ]);
    expect((await store().list({ type: TYPES.export })).items).toEqual([]);
    await other.close();
    removeOther();
  });
});
