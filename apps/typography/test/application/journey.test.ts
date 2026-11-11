/**
 * The contract of the application interface, as three journeys with no
 * browser. Each one imports a file, makes or recovers glyphs, accepts them,
 * exports a font and renders text in it. The application is closed and opened
 * again between every command, as it is between two calls of the command line,
 * so whatever a later command needs has to be in the saved project or in an
 * artifact, never in memory.
 *
 * The cases of a journey are one sequence. They run in order on one project,
 * and each starts from what the case before it left.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Application, Inspection } from "~/application/application";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { fixtureAt, recordedRun, tempProject } from "./helpers/project";

const coverage = (inspection: Inspection, faceId: string, script: string) =>
  inspection.faces
    .find((face) => face.faceId === faceId)
    ?.coverage.find((entry) => entry.script === script);

describe("extending a font with generated glyphs", () => {
  const { open, remove, reopen } = tempProject();
  let app: Application;
  let faceId = "";

  beforeAll(async () => {
    app = await open();
  });
  afterAll(async () => {
    await app.close();
    remove();
  });

  it("imports a font file as an artifact and says what it holds", async () => {
    const imported = await app.import([fixtureAt("fonts/Lato-Regular.ttf")]);
    expect(imported.refused).toEqual([]);
    expect(imported.fonts).toHaveLength(1);
    const [font] = imported.fonts;
    expect(font?.artifactId).toBeTruthy();
    faceId = font?.faces[0]?.faceId ?? "";

    app = await reopen(app);
    const inspection = app.inspect();
    expect(inspection.revisions).toBe(0);
    expect(inspection.faces).toHaveLength(1);
    expect(inspection.faces[0]).toMatchObject({
      editable: true,
      faceId,
      label: "Lato Regular",
    });
    expect(coverage(inspection, faceId, "Latn")?.covered).toBeGreaterThan(900);
    expect(coverage(inspection, faceId, "Deva")).toMatchObject({ covered: 0 });
  });

  let runId = "";

  it("generates a script extension that waits, whole, until it is accepted", async () => {
    const run = await app.generate({
      faceId,
      kind: "script-extension",
      plan: "devanagari-subset",
      recordedRun: recordedRun("2026-11-10-devanagari-subset"),
    });
    ({ runId } = run);
    // Recorded model output, replayed: it says so, and it is kept as an artifact.
    expect(run.source).toMatchObject({
      model: "ideogram/vector/text-to-vector",
      recorded: true,
    });
    expect(run.modelOutput).toBeTruthy();
    expect(run.glyphs).toHaveLength(18);
    expect(run.unmade).toEqual([]);

    app = await reopen(app);
    const waiting = app.inspect();
    expect(coverage(waiting, faceId, "Deva")).toMatchObject({ covered: 0 });
    expect(waiting.waiting.runs).toEqual([
      expect.objectContaining({ faceId, glyphs: 18, runId }),
    ]);
  });

  it("accepts the extension as one revision", async () => {
    const accepted = await app.accept({ run: runId });
    expect(accepted).toMatchObject({ accepted: 18, revisions: 1 });

    app = await reopen(app);
    const inspection = app.inspect();
    expect(inspection.revisions).toBe(1);
    expect(inspection.waiting.runs).toEqual([]);
    expect(coverage(inspection, faceId, "Deva")).toMatchObject({ covered: 15 });
  });

  it("generates single characters as candidates and accepts one of them", async () => {
    const run = await app.generate({
      faceId,
      kind: "recorded",
      output: "vector-model",
      recordedRun: recordedRun("2026-11-10-latin-holdout"),
    });
    expect(run.candidates.map((candidate) => candidate.text)).toEqual([
      "R",
      "G",
      "a",
      "g",
      "k",
      "2",
    ]);
    expect(run.candidates.every((made) => made.verdict !== "fail")).toBe(true);

    app = await reopen(app);
    expect(app.inspect().waiting.candidates).toHaveLength(6);
    const [first] = run.candidates;
    const accepted = await app.accept({ candidates: [first?.id ?? ""] });
    expect(accepted).toMatchObject({ accepted: 1, revisions: 2 });

    app = await reopen(app);
    expect(app.inspect().waiting.candidates).toHaveLength(5);
  });

  let exported: Awaited<ReturnType<Application["export"]>>;

  it("exports a renamed font as an artifact, with what was checked", async () => {
    exported = await app.export({ faces: [faceId], familyName: "Atlas Sans" });
    expect(exported.problems).toEqual([]);
    expect(exported.fonts).toHaveLength(1);
    const [font] = exported.fonts;
    expect(font?.fileName).toBe("AtlasSans-Regular.ttf");
    expect(font?.checks.filter((check) => check.outcome === "fail")).toEqual(
      []
    );
    // Without a browser the browser's own check cannot run, and says so.
    expect(font?.checks.map((check) => check.outcome)).toContain("not-run");

    const derived = harfBuzzReader.open(font?.bytes ?? new Uint8Array());
    expect(derived.description.familyName).toBe("Atlas Sans");
    expect(derived.shape("नमस्ते", { script: "Deva" }).glyphs).toHaveLength(5);
    expect(derived.shape("fi").glyphs).toHaveLength(1);
    derived.close();
  });

  it("renders text in the exported font, and names what the font lacks", async () => {
    app = await reopen(app);
    const [font] = exported.fonts;
    const picture = await app.render({
      font: font?.ref ?? { artifactId: "" },
      text: "Hamburg नमस्ते",
    });
    expect(picture.svg.startsWith("<svg")).toBe(true);
    expect(picture.missing).toEqual([]);
    expect(picture.svg).toContain("<path");

    const lacking = await app.render({
      font: font?.ref ?? { artifactId: "" },
      text: "日",
    });
    expect(lacking.missing).toEqual(["日"]);
  });

  it("reopens to the same project and builds the same bytes again", async () => {
    const before = app.inspect();
    app = await reopen(app);
    expect(app.inspect()).toEqual(before);

    const again = await app.export({
      faces: [faceId],
      familyName: "Atlas Sans",
    });
    const [first] = exported.fonts;
    const [second] = again.fonts;
    // Same project, same clock: the same font, kept as a second version.
    expect(second?.digest).toBe(first?.digest);
    expect(second?.ref.artifactId).toBe(first?.ref.artifactId);
    expect(second?.ref.contentId).not.toBe(first?.ref.contentId);
    expect(app.inspect().exports).toEqual([
      expect.objectContaining({
        fileName: "AtlasSans-Regular.ttf",
        versions: 2,
      }),
    ]);
  });
});

describe("recovering a typeface from a photograph", () => {
  const { open, remove, reopen } = tempProject();
  let app: Application;

  beforeAll(async () => {
    app = await open();
  });
  afterAll(async () => {
    await app.close();
    remove();
  });

  it("imports the photograph and reference fonts, recovers the letters and completes the alphabet", async () => {
    const imported = await app.import([
      fixtureAt("fonts/Lato-Regular.ttf"),
      fixtureAt("fonts/SofiaSans-wght.ttf"),
      fixtureAt("evidence/storefront-needed-things.jpg"),
    ]);
    expect(imported.fonts).toHaveLength(2);
    expect(imported.photographs).toHaveLength(1);
    const [photograph] = imported.photographs;

    app = await reopen(app);
    const recovered = await app.reconstruct({
      complete: {
        kind: "recorded",
        recordedRun: recordedRun("2026-11-10-storefront-completion"),
      },
      destination: { familyName: "Storefront Needed Things", kind: "new" },
      photograph: photograph?.artifactId ?? "",
      region: { height: 196, width: 400, x: 432, y: 162 },
      text: ["NEEDED THINGS", "FOR SALE"],
    });
    expect(recovered.found).toBe(19);
    expect(
      recovered.observed
        .map((made) => made.text)
        .sort()
        .join("")
    ).toBe("ADEFGHILNORST");
    expect(recovered.observed.every((made) => made.fit > 0.9)).toBe(true);
    // Fifteen more come from the recorded run. They were not in the photograph.
    expect(recovered.inferred).toHaveLength(15);
    expect(recovered.inferred.every((made) => made.recorded)).toBe(true);

    app = await reopen(app);
    const accepted = await app.accept({ candidates: "all" });
    expect(accepted.accepted).toBe(28);

    app = await reopen(app);
    const exported = await app.export({
      faces: [recovered.faceId],
      familyName: "Storefront Needed Things",
    });
    const [font] = exported.fonts;
    const picture = await app.render({
      font: font?.ref ?? { artifactId: "" },
      text: "NEEDED THINGS",
    });
    expect(picture.missing).toEqual([]);
    // A reconstruction says where its letters came from when it is exported.
    expect(exported.warnings.join(" ")).toContain("photograph");
  });
});

describe("what the interface refuses", () => {
  const { open, remove } = tempProject();
  let app: Application;

  beforeAll(async () => {
    app = await open();
  });
  afterAll(async () => {
    await app.close();
    remove();
  });

  it("names a file it cannot read, and still imports the rest", async () => {
    const imported = await app.import([
      { bytes: new Uint8Array([1, 2, 3]), name: "broken.ttf" },
      fixtureAt("fonts/Lato-Regular.ttf"),
    ]);
    expect(imported.fonts).toHaveLength(1);
    expect(imported.refused).toEqual([
      expect.objectContaining({ name: "broken.ttf" }),
    ]);
  });

  it("refuses a derived font that keeps a reserved name, and builds nothing", async () => {
    const [face] = app.inspect().faces;
    const exported = await app.export({
      faces: [face?.faceId ?? ""],
      familyName: "Lato Subset",
    });
    expect(exported.fonts).toEqual([]);
    expect(exported.problems.join(" ")).toContain("Lato");
  });

  it("does not call a model without a key", async () => {
    const [face] = app.inspect().faces;
    await expect(
      app.generate({
        characters: "é",
        faceId: face?.faceId ?? "",
        kind: "characters",
        strategy: "vector-model",
      })
    ).rejects.toThrow("key");
  });
});
