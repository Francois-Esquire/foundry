import { afterEach, describe, expect, it } from "vitest";
import type { Application } from "~/application/application";
import { candidateStatuses } from "~/typeface/project";
import {
  fixtureAt,
  found,
  importLato,
  recordedRun,
  tempProject,
} from "./helpers/project";

const projects: ReturnType<typeof tempProject>[] = [];
const applications: Application[] = [];
const setup = async () => {
  const project = tempProject();
  projects.push(project);
  const app = await project.open();
  applications.push(app);
  const { faceId } = await importLato(app);
  return { ...project, app, faceId };
};
const recorded = (app: Application, faceId: string) =>
  app.generate({
    faceId,
    kind: "recorded",
    output: "vector-model",
    recordedRun: recordedRun("2026-11-10-latin-holdout"),
  });

afterEach(async () => {
  for (const app of applications.splice(0)) {
    await app.close();
  }
  for (const project of projects.splice(0)) {
    project.remove();
  }
});

describe("a returned run id names a run", () => {
  it.each(["recorded", "procedural"] as const)(
    "R1 and R2: inspects and accepts a %s run after reopening",
    async (kind) => {
      const { app, faceId, reopen } = await setup();
      const run =
        kind === "recorded"
          ? await recorded(app, faceId)
          : await app.generate({
              characters: "é è ñ",
              faceId,
              kind: "characters",
              strategy: "procedural",
            });
      expect(run.candidates.length).toBeGreaterThan(0);
      expect(app.inspect().waiting.candidates).toEqual(
        run.candidates.map((candidate) =>
          expect.objectContaining({ id: candidate.id, runId: run.runId })
        )
      );
      const opened = await reopen(app);
      applications.splice(applications.indexOf(app), 1, opened);
      const before = opened.inspect().revisions;
      expect(await opened.accept({ run: run.runId })).toEqual({
        accepted: run.candidates.length,
        revisions: before + run.candidates.length,
      });
      expect(opened.inspect().waiting.candidates).toEqual([]);
      const statuses = candidateStatuses(opened.workspace.getState().project);
      expect(run.candidates.map(({ id }) => statuses.get(id))).toEqual(
        run.candidates.map(() => "accepted")
      );
      // A settled run waits no more: its id refuses, and nothing changes.
      const settled = opened.workspace.getState().project;
      await expect(opened.accept({ run: run.runId })).rejects.toThrow(
        `No run ${run.runId} is waiting. This project has no waiting run.`
      );
      expect(opened.workspace.getState().project).toBe(settled);
    }
  );

  it("R3: accepts only the candidates from the named run", async () => {
    const { app, faceId } = await setup();
    const first = await recorded(app, faceId);
    const second = await app.generate({
      characters: "é",
      faceId,
      kind: "characters",
      strategy: "procedural",
    });
    expect(first.runId).not.toBe(second.runId);
    expect(await app.accept({ run: first.runId })).toMatchObject({
      accepted: first.candidates.length,
    });
    expect(app.inspect().waiting.candidates.map(({ id }) => id)).toEqual(
      second.candidates.map(({ id }) => id)
    );
  });

  it("R4a: a stable run id groups both replays of source replacements", async () => {
    const { app, faceId } = await setup();
    const first = await recorded(app, faceId);
    const second = await recorded(app, faceId);
    // The id names the model run. A second replay proposes the same designs again.
    expect(second.runId).toBe(first.runId);
    const candidates = [...first.candidates, ...second.candidates];
    expect(candidates).toHaveLength(12);
    expect(app.inspect().waiting.candidates).toEqual(
      candidates.map(({ id }) =>
        expect.objectContaining({ id, runId: first.runId })
      )
    );
    const before = app.inspect().revisions;
    expect(await app.accept({ run: first.runId })).toEqual({
      accepted: 12,
      revisions: before + 12,
    });
    expect(
      app.workspace
        .getState()
        .project.revisions.slice(before)
        .map(({ accepts }) => accepts)
    ).toEqual(candidates.map(({ id }) => id));
    expect(app.inspect().waiting.candidates).toEqual([]);
  });

  it.each(["run", "candidates"] as const)(
    "R4b: accepting additions by %s stops at the second replay's first candidate",
    async (selection) => {
      const { app } = await setup();
      const imported = await app.import([
        fixtureAt("evidence/storefront-needed-things.jpg"),
      ]);
      const recovered = await app.reconstruct({
        destination: { familyName: "Banner", kind: "new" },
        photograph: found(imported.photographs[0]).artifactId,
        region: { height: 196, width: 400, x: 432, y: 162 },
        text: ["NEEDED THINGS", "FOR SALE"],
      });
      const first = await recorded(app, recovered.faceId);
      const second = await recorded(app, recovered.faceId);
      expect(second.runId).toBe(first.runId);
      expect(first.candidates).toHaveLength(6);
      const before = app.inspect().revisions;
      const result = await app.accept(
        selection === "run"
          ? { run: first.runId }
          : {
              candidates: [...first.candidates, ...second.candidates].map(
                ({ id }) => id
              ),
            }
      );
      expect(result).toEqual({
        accepted: 6,
        refused: {
          id: found(second.candidates[0]).id,
          reason: expect.any(String),
        },
        revisions: before + 6,
      });
      expect(result.refused?.reason).toBe(
        "This face already has an added glyph named uni0052. Give the new glyph another name."
      );
      expect(
        app
          .inspect()
          .waiting.candidates.filter(({ id }) =>
            second.candidates.some((candidate) => candidate.id === id)
          )
          .map(({ id }) => id)
      ).toEqual(second.candidates.map(({ id }) => id));
    }
  );

  it("R5: accepts a held extension before candidates with the same provenance run id", async () => {
    const { app, faceId } = await setup();
    const run = await app.generate({
      faceId,
      kind: "script-extension",
      plan: "devanagari-subset",
      recordedRun: recordedRun("2026-11-10-devanagari-subset"),
    });
    await app.generate({
      characters: "é",
      faceId,
      kind: "characters",
      strategy: "procedural",
    });
    const candidate = found(app.workspace.getState().project.candidates[0]);
    const collision = {
      ...candidate,
      id: "same-run-candidate",
      provenance: {
        createdAt: "2026-11-10T12:00:00.000Z",
        origin: "generated" as const,
        runId: run.runId,
        strategy: "procedural",
      },
    };
    expect(app.workspace.propose([collision]).ok).toBe(true);
    expect(app.inspect().waiting.runs.map(({ runId }) => runId)).toContain(
      run.runId
    );
    const before = app.inspect().revisions;
    expect(await app.accept({ run: run.runId })).toEqual({
      accepted: run.glyphs.length,
      revisions: before + 1,
    });
    expect(app.inspect().waiting.runs).toEqual([]);
    expect(app.inspect().waiting.candidates.map(({ id }) => id)).toContain(
      collision.id
    );
  });

  it("R6: keeps the refusal for an id that names nothing", async () => {
    const { app } = await setup();
    await expect(app.accept({ run: "no-such-run" })).rejects.toThrow(
      "No run no-such-run is waiting. This project has no waiting run."
    );
  });

  it("R7: gives inferred letters their completion run id and traced letters none", async () => {
    const { app, faceId } = await setup();
    const imported = await app.import([
      fixtureAt("evidence/storefront-needed-things.jpg"),
    ]);
    const recovered = await app.reconstruct({
      complete: {
        kind: "recorded",
        recordedRun: recordedRun("2026-11-10-storefront-completion"),
      },
      destination: { faceId, kind: "existing" },
      photograph: found(imported.photographs[0]).artifactId,
      region: { height: 196, width: 400, x: 432, y: 162 },
      text: ["NEEDED THINGS", "FOR SALE"],
    });
    expect(recovered.observed.length).toBeGreaterThan(0);
    expect(recovered.inferred.length).toBeGreaterThan(0);
    const waiting = app.inspect().waiting.candidates;
    for (const { id } of recovered.observed) {
      expect(
        found(waiting.find((candidate) => candidate.id === id)).runId
      ).toBeUndefined();
    }
    for (const { id } of recovered.inferred) {
      const { provenance } = found(
        app.workspace
          .getState()
          .project.candidates.find((candidate) => candidate.id === id)
      );
      expect(provenance.origin).toBe("reconstructed");
      if (provenance.origin !== "reconstructed") {
        throw new Error("Expected reconstructed lettering.");
      }
      expect(found(provenance.inferredBy).runId).toBeTruthy();
      expect(
        found(waiting.find((candidate) => candidate.id === id))
      ).toMatchObject({ runId: found(provenance.inferredBy).runId });
    }
  });
});
