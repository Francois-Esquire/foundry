/**
 * What the commands do beyond the journeys: accepting, refusing, and keeping
 * live model output.
 *
 * The cases of each group are one sequence. They run in order on one project,
 * and each starts from what the case before it left.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Application } from "~/application/application";
import { Refusal } from "~/application/refusal";
import { withFalStorage } from "../generation/helpers/fal";
import {
  AT,
  FIXTURES,
  fixtureAt,
  found,
  importLato,
  recordedRun,
  tempProject,
} from "./helpers/project";

const ISSUED = /^id-\d+/;

describe("accepting candidates", () => {
  const { open, remove, reopen } = tempProject();
  let app: Application;
  let faceId = "";

  beforeAll(async () => {
    app = await open();
    ({ faceId } = await importLato(app));
  });

  afterAll(async () => {
    await app.close();
    remove();
  });

  it("generates by rule with the application's own clock and ids, and keeps no model output", async () => {
    const run = await app.generate({
      characters: "é è U+00F1",
      faceId: "Lato Regular",
      kind: "characters",
      strategy: "procedural",
    });
    expect(run.source).toEqual({
      model: undefined,
      recorded: false,
      strategy: "procedural",
    });
    expect(run.modelOutput).toBeUndefined();
    expect(run.candidates.map((made) => made.text)).toEqual(["é", "è", "ñ"]);
    expect(run.runId).toMatch(ISSUED);
    const { candidates } = app.workspace.getState().project;
    for (const candidate of candidates) {
      expect(candidate.id).toMatch(ISSUED);
      expect(candidate.provenance).toMatchObject({ createdAt: AT });
    }
  });

  it("accepts the ones that passed, in a later process, from verdicts kept with the project", async () => {
    const recorded = await app.generate({
      faceId,
      kind: "recorded",
      output: "image-model",
      recordedRun: recordedRun("2026-11-10-latin-holdout"),
    });
    app = await reopen(app);
    const waiting = app.inspect().waiting.candidates;
    const passed = waiting.filter((candidate) => candidate.verdict === "pass");
    // The three made by rule passed. The six traced from the recorded
    // picture are for a person to review, and must be left waiting.
    expect(passed.map((candidate) => candidate.text)).toEqual(["é", "è", "ñ"]);
    expect(recorded.candidates.map((made) => made.verdict)).toEqual(
      Array.from({ length: 6 }, () => "review")
    );
    const before = app.inspect().revisions;
    const accepted = await app.accept({ candidates: "passed" });
    expect(accepted).toEqual({
      accepted: passed.length,
      revisions: before + passed.length,
    });
    const left = app.inspect().waiting.candidates;
    expect(left).toHaveLength(waiting.length - passed.length);
    expect(left.every((candidate) => candidate.verdict !== "pass")).toBe(true);
  });

  it("stops at the first candidate the project refuses and says which", async () => {
    const [first, second] = app.inspect().waiting.candidates;
    const accepted = await app.accept({
      candidates: [first?.id ?? "", "no-such-candidate", second?.id ?? ""],
    });
    expect(accepted.accepted).toBe(1);
    expect(accepted.refused).toEqual({
      id: "no-such-candidate",
      reason: "This project has no candidate no-such-candidate.",
    });
    expect(
      app.inspect().waiting.candidates.map((candidate) => candidate.id)
    ).toContain(second?.id);
  });

  it("refuses outright when nothing could be accepted", async () => {
    await expect(
      app.accept({ candidates: ["no-such-candidate"] })
    ).rejects.toThrow(Refusal);
    await expect(app.accept({ run: "no-such-run" })).rejects.toThrow(
      "No run no-such-run is waiting."
    );
  });

  it("accepts nothing, and says so, when nothing is waiting", async () => {
    await app.accept({ candidates: "all" });
    expect(await app.accept({ candidates: "all" })).toMatchObject({
      accepted: 0,
    });
  });
});

describe("what generate refuses", () => {
  const { open, remove } = tempProject();
  let app: Application;
  let faceId = "";

  beforeAll(async () => {
    app = await open();
    ({ faceId } = await importLato(app));
    await app.import([fixtureAt("fonts/NotoSansDevanagari-wdth-wght.ttf")]);
  });

  afterAll(async () => {
    await app.close();
    remove();
  });

  it("names the faces when it is given one the project does not have", async () => {
    await expect(
      app.generate({
        characters: "é",
        faceId: "Lato Bold",
        kind: "characters",
        strategy: "procedural",
      })
    ).rejects.toThrow(
      "This project has no face Lato Bold. Its faces are: Lato Regular, Noto Sans Devanagari Regular."
    );
  });

  it("asks which output to replay when a recorded run has several", async () => {
    await expect(
      app.generate({
        faceId,
        kind: "recorded",
        recordedRun: recordedRun("2026-11-10-latin-holdout"),
      })
    ).rejects.toThrow(
      "has 2 outputs: image-model, vector-model. Name the one to replay."
    );
  });

  it("says a directory is not a recorded run", async () => {
    await expect(
      app.generate({
        faceId,
        kind: "recorded",
        recordedRun: path.join(FIXTURES, "fonts"),
      })
    ).rejects.toThrow("has no run.json, so it is not a recorded run.");
    await expect(
      app.generate({
        faceId,
        kind: "recorded",
        recordedRun: path.join(FIXTURES, "nowhere"),
      })
    ).rejects.toThrow("There is no recorded run at");
  });

  it("does not offer a script extension to a face that has the script, or under an unknown plan", async () => {
    await expect(
      app.generate({
        faceId: "Noto Sans Devanagari Regular",
        kind: "script-extension",
        plan: "devanagari-subset",
        recordedRun: recordedRun("2026-11-10-devanagari-subset"),
      })
    ).rejects.toThrow("so it is not offered for this face");
    await expect(
      app.generate({
        faceId,
        kind: "script-extension",
        plan: "tamil-subset",
        recordedRun: recordedRun("2026-11-10-devanagari-subset"),
      })
    ).rejects.toThrow(
      "There is no script extension plan named tamil-subset. The plans are: devanagari-subset."
    );
    expect(app.inspect().waiting.runs).toEqual([]);
  });

  it("proposes nothing when a run fails", () => {
    expect(app.inspect().waiting.candidates).toEqual([]);
  });

  it("runs nothing once it is closed", async () => {
    const { open: openOther, remove: removeOther } = tempProject();
    const other = await openOther();
    await other.close();
    expect(() => other.inspect()).toThrow("This application is closed.");
    await expect(other.save()).rejects.toThrow("This application is closed.");
    await expect(other.import([])).rejects.toThrow(Refusal);
    removeOther();
  });
});

describe("what a model returned", () => {
  const sheet = readFileSync(
    path.join(
      recordedRun("2026-11-10-latin-holdout"),
      "ideogram-vector-medium.svg"
    ),
    "utf8"
  );
  const calls: string[] = [];
  /** A stand-in for the model: it answers with a saved sheet and the network is never reached. */
  const model: typeof fetch = (input) => {
    calls.push(String(input));
    return Promise.resolve(
      Response.json({
        images: [
          {
            content_type: "image/svg+xml",
            url: `data:image/svg+xml,${encodeURIComponent(sheet)}`,
          },
        ],
      })
    );
  };
  const { artifacts, open, remove } = tempProject({
    modelFetch: withFalStorage(model),
    providerKey: "test-key",
  });
  const replayDirectory = mkdtempSync(path.join(tmpdir(), "typography-run-"));
  let app: Application;
  let faceId = "";

  beforeAll(async () => {
    app = await open();
    ({ faceId } = await importLato(app));
  });

  afterAll(async () => {
    await app.close();
    remove();
    rmSync(replayDirectory, { force: true, recursive: true });
  });

  it("is kept as an artifact in the recorded-run format and can be replayed without the model", async () => {
    const live = await app.generate({
      characters: "RGagk2",
      faceId,
      kind: "characters",
      strategy: "vector-model",
    });
    expect(calls).toEqual(["https://fal.run/ideogram/vector/text-to-vector"]);
    expect(live.source).toEqual({
      model: "ideogram/vector/text-to-vector",
      recorded: false,
      strategy: "vector-model",
    });
    expect(live.candidates.length).toBeGreaterThan(0);

    const outputs = await artifacts().list({
      type: "application/vnd.foundry.typography.model-output",
    });
    const kept = found(
      outputs.items.find((artifact) => artifact.id === live.modelOutput)
    );
    const content = found(kept.content);
    expect(content.state).toBe("frozen");
    const names = Object.keys(content.tree);
    expect(names.sort()).toEqual([
      "prompt.txt",
      "reference.svg",
      "run.json",
      "sheet.svg",
    ]);
    for (const name of names) {
      const file = await artifacts().readFile(content.id, name);
      writeFileSync(path.join(replayDirectory, name), found(file).blob);
    }
    // The sheet is kept exactly as the model returned it.
    expect(readFileSync(path.join(replayDirectory, "sheet.svg"), "utf8")).toBe(
      sheet
    );

    const replayed = await app.generate({
      faceId,
      kind: "recorded",
      recordedRun: replayDirectory,
    });
    expect(calls).toHaveLength(1);
    expect(replayed.source).toEqual({
      model: "ideogram/vector/text-to-vector",
      recorded: true,
      strategy: "vector-model",
    });
    expect(replayed.candidates.map((made) => made.text)).toEqual(
      live.candidates.map((made) => made.text)
    );
    expect(replayed.candidates.map((made) => made.verdict)).toEqual(
      live.candidates.map((made) => made.verdict)
    );
  });
});
