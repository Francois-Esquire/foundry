/** What the reconstruct command refuses, and what it keeps beside the candidates. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Application } from "~/application/application";
import { fixtureAt, recordedRun, tempProject } from "./helpers/project";

const ISSUED = /^id-\d+/;
const MODEL_OUTPUT = /^model-output-[0-9a-f]{64}$/;

describe("what reconstruct refuses", () => {
  const { open, remove } = tempProject();
  let app: Application;
  let photograph = "";
  const region = { height: 196, width: 400, x: 432, y: 162 };

  beforeAll(async () => {
    app = await open();
    const imported = await app.import([
      fixtureAt("fonts/Lato-Regular.ttf"),
      fixtureAt("evidence/storefront-needed-things.jpg"),
    ]);
    photograph = imported.photographs[0]?.artifactId ?? "";
  });

  afterAll(async () => {
    await app.close();
    remove();
  });

  it("names a photograph the project does not have", async () => {
    await expect(
      app.reconstruct({
        destination: { familyName: "Banner", kind: "new" },
        photograph: "photograph-of-nothing",
        region,
      })
    ).rejects.toThrow("This project has no photograph photograph-of-nothing.");
  });

  it("says when the text does not have one character for each letter found", async () => {
    await expect(
      app.reconstruct({
        destination: { familyName: "Banner", kind: "new" },
        photograph,
        region,
        text: ["NEEDED", "FOR SALE"],
      })
    ).rejects.toThrow("Line 1 has 12 letters and the text given for it has 6.");
    expect(app.inspect().waiting.candidates).toEqual([]);
  });

  it("asks for a name before it makes a new face", async () => {
    await expect(
      app.reconstruct({
        destination: { familyName: " ", kind: "new" },
        photograph,
        region,
        text: ["NEEDED THINGS", "FOR SALE"],
      })
    ).rejects.toThrow("Give the new face a name");
  });

  it("proposes the letters to a face the project already has, read by the recogniser alone", async () => {
    const recovered = await app.reconstruct({
      destination: { faceId: "Lato Regular", kind: "existing" },
      photograph,
      region,
    });
    expect(recovered.found).toBe(19);
    expect(recovered.inferred).toEqual([]);
    expect(recovered.modelOutput).toBeUndefined();
    expect(recovered.observed.length).toBeGreaterThan(8);
    expect(app.inspect().faces.map((face) => face.label)).toEqual([
      "Lato Regular",
    ]);
  });

  it("gives inferred letters ids from the application, and keeps their verdicts and the run", async () => {
    const { open: openOther, remove: removeOther, reopen } = tempProject();
    let other = await openOther();
    const imported = await other.import([
      fixtureAt("fonts/Lato-Regular.ttf"),
      fixtureAt("evidence/storefront-needed-things.jpg"),
    ]);
    const recovered = await other.reconstruct({
      complete: {
        kind: "recorded",
        recordedRun: recordedRun("2026-11-10-storefront-completion"),
      },
      destination: { faceId: "Lato Regular", kind: "existing" },
      photograph: imported.photographs[0]?.artifactId ?? "",
      region,
      text: ["NEEDED THINGS", "FOR SALE"],
    });
    expect(recovered.inferred).toHaveLength(15);
    for (const inferred of recovered.inferred) {
      expect(inferred.id).toMatch(ISSUED);
      expect(inferred).toMatchObject({
        model: "ideogram/vector/text-to-vector",
        recorded: true,
      });
    }
    expect(recovered.modelOutput).toMatch(MODEL_OUTPUT);
    other = await reopen(other);
    const waiting = other.inspect().waiting.candidates;
    const inferred = waiting.filter((candidate) =>
      recovered.inferred.some((made) => made.id === candidate.id)
    );
    expect(inferred).toHaveLength(15);
    // An inferred letter was evaluated by its run. A traced one was not.
    expect(inferred.every((candidate) => candidate.verdict !== undefined)).toBe(
      true
    );
    expect(
      waiting
        .filter((candidate) => !inferred.includes(candidate))
        .every((candidate) => candidate.verdict === undefined)
    ).toBe(true);
    expect(
      waiting.every((candidate) => candidate.origin === "reconstructed")
    ).toBe(true);
    await other.close();
    removeOther();
  });
});
