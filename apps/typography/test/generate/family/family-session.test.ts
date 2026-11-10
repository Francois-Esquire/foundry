import { describe, expect, it } from "vitest";
import { faceStyleName } from "~/typeface/face";
import { appliedChanges } from "~/typeface/project";
import { withFalStorage } from "../../generation/helpers/fal";
import { fixtureFetch } from "../helpers/session";
import { ACCENTED, codes, sofiaSession } from "./helpers/family-session";

const LETTERS = [...ACCENTED];

describe("a coordinated run with the procedural strategy", () => {
  it("pins each weight, proposes every candidate and accepts none", async () => {
    const { faceId, request, session, workspace } = await sofiaSession();
    await session.run(request());
    const { activity, runs, shownRunId } = session.getState();
    const [run] = runs;
    expect(activity?.failure).toBeUndefined();
    expect(activity?.status).toBe("finished");
    expect(activity?.lines).toEqual([
      {
        detail: "6 candidates.",
        name: "Light",
        status: "generated",
        weight: 300,
      },
      {
        detail: "6 candidates.",
        name: "Regular",
        status: "generated",
        weight: 400,
      },
      {
        detail: "6 candidates.",
        name: "ExtraBold",
        status: "generated",
        weight: 800,
      },
    ]);
    expect(shownRunId).toBe(run?.id);
    expect(run?.faceId).toBe(faceId);
    expect(run?.strategy).toMatchObject({ kind: "procedural" });
    expect(run?.strategy.model).toBeUndefined();

    const { project } = workspace.getState();
    const pinned = project.faces.filter((face) => face.pinned);
    expect(pinned.map(faceStyleName)).toEqual([
      "Light",
      "Regular",
      "ExtraBold",
    ]);
    expect(run?.members.map((member) => member.faceId)).toEqual(
      pinned.map((face) => face.id)
    );
    expect(project.candidates).toHaveLength(3 * LETTERS.length);
    expect(
      project.candidates.every((candidate) => candidate.status === "proposed")
    ).toBe(true);
    expect(project.revisions).toEqual([]);
  });

  it("lists each character's candidates lightest first and says they are compatible", async () => {
    const { request, session } = await sofiaSession();
    await session.run(request({ weights: [800, 300, 400] }));
    const [run] = session.getState().runs;
    expect(run?.members.map((member) => member.weight)).toEqual([
      300, 400, 800,
    ]);
    expect(run?.characters.map(({ target }) => target.text)).toEqual(LETTERS);
    for (const character of run?.characters ?? []) {
      expect(character.compatible).toBe(true);
      expect(character.reason).toBeUndefined();
      expect(character.cells.map((cell) => cell.candidate?.faceId)).toEqual(
        run?.members.map((member) => member.faceId)
      );
      expect(character.cells.every((cell) => cell.verdict !== undefined)).toBe(
        true
      );
      expect(character.cells[0]?.candidate?.provenance).toMatchObject({
        origin: "generated",
        strategy: "procedural",
      });
    }
  });

  it("accepts one character at every weight, each as a revision on its own instance", async () => {
    const { request, session, workspace } = await sofiaSession();
    await session.run(request());
    const [run] = session.getState().runs;
    expect(session.acceptCharacter(run?.id ?? "", "u+0109")).toBe(3);
    const { project } = workspace.getState();
    expect(project.revisions).toHaveLength(3);
    for (const member of run?.members ?? []) {
      const changes = appliedChanges(project, member.faceId);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        glyph: { characters: [0x01_09], name: "uni0109" },
        kind: "glyph-added",
      });
    }
    expect(
      project.candidates.filter((candidate) => candidate.status === "accepted")
    ).toHaveLength(3);
    // Asking again accepts nothing more.
    expect(session.acceptCharacter(run?.id ?? "", "u+0109")).toBe(0);
  });

  it("accepts everything that is compatible, and rejects a character at every weight", async () => {
    const { request, session, workspace } = await sofiaSession();
    await session.run(request());
    const runId = session.getState().runs[0]?.id ?? "";
    expect(session.rejectCharacter(runId, "u+0169")).toBe(3);
    expect(session.acceptCompatible(runId)).toBe(3 * (LETTERS.length - 1));
    const { project } = workspace.getState();
    expect(project.revisions).toHaveLength(3 * (LETTERS.length - 1));
    for (const face of project.faces.filter((known) => known.pinned)) {
      expect(
        workspace.workingFace(face.id).added.map((glyph) => glyph.characters[0])
      ).toEqual(codes("ĉĝǵĤǐ"));
    }
    expect(
      project.candidates.filter((candidate) => candidate.status === "rejected")
    ).toHaveLength(3);
  });

  it("redraws a character an instance already has, instead of colliding with it", async () => {
    const { request, session, workspace } = await sofiaSession();
    await session.run(request({ characters: codes("ĉ") }));
    session.acceptCompatible(session.getState().runs[0]?.id ?? "");
    await session.run(request({ characters: codes("ĉĝ") }));
    const [second] = session.getState().runs;
    expect(session.getState().runs).toHaveLength(2);
    expect(
      second?.characters[0]?.cells.map((cell) => cell.candidate?.replaces?.kind)
    ).toEqual(["added", "added", "added"]);
    expect(session.acceptCompatible(second?.id ?? "")).toBe(6);
    expect(workspace.getState().notices).toEqual([]);
    for (const face of workspace
      .getState()
      .project.faces.filter((known) => known.pinned)) {
      expect(workspace.workingFace(face.id).added).toHaveLength(2);
    }
  });

  it("leaves out characters the face has, and refuses a request with nothing else", async () => {
    const { request, session, workspace } = await sofiaSession();
    await session.run(request({ characters: codes("aé") }));
    const { activity, runs } = session.getState();
    expect(runs).toEqual([]);
    expect(activity?.status).toBe("failed");
    expect(activity?.failure).toBe(
      "No characters the face lacks were asked for. Choose what to generate, then run again."
    );
    expect(workspace.getState().project.faces).toHaveLength(1);
  });

  it("refuses fewer than two weights in the family engine's words, and pins nothing", async () => {
    const { faceId, request, session, workspace } = await sofiaSession();
    await session.run(request({ weights: [300, 300] }));
    expect(session.getState().activity).toEqual({
      faceId,
      failure: "Coordinated generation needs at least two different weights.",
      lines: [],
      status: "failed",
    });
    expect(workspace.getState().project.faces).toHaveLength(1);
  });

  it("refuses a face that has no weight axis", async () => {
    const { request, session, workspace } = await sofiaSession();
    await session.run(request());
    const pinned = workspace
      .getState()
      .project.faces.find((face) => face.pinned);
    await session.run(request({ faceId: pinned?.id ?? "" }));
    expect(session.getState().activity?.failure).toContain(
      "has no weight axis"
    );
    expect(session.getState().runs).toHaveLength(1);
  });

  it("keeps the weights a person chose for a face", async () => {
    const { faceId, session } = await sofiaSession();
    session.setWeights(faceId, [200, 600]);
    expect(session.getState().weights).toEqual({ [faceId]: [200, 600] });
  });
});

describe("a coordinated run with a model strategy", () => {
  const sheetResponse = async () => {
    const sheet = await fixtureFetch(
      "/recorded-runs/2026-11-10-latin-holdout/ideogram-vector-medium.svg"
    );
    const svg = await sheet.text();
    return () =>
      Response.json({
        images: [
          {
            content_type: "image/svg+xml",
            url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
          },
        ],
      });
  };

  it("makes one call for each weight", async () => {
    const answer = await sheetResponse();
    let calls = 0;
    const modelFetch: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(answer());
    };
    const { request, session } = await sofiaSession({
      modelFetch: withFalStorage(modelFetch),
    });
    await session.run(
      request({ providerKey: "test-key", strategy: "vector-model" })
    );
    expect(calls).toBe(3);
    const [run] = session.getState().runs;
    expect(run?.strategy).toMatchObject({
      kind: "vector-model",
      model: "ideogram/vector/text-to-vector",
    });
    expect(run?.members.map((member) => member.status)).toEqual([
      "generated",
      "generated",
      "generated",
    ]);
  });

  it("names the weight that failed with its reason, keeps the weights before it and starts none after it", async () => {
    const answer = await sheetResponse();
    let calls = 0;
    const modelFetch: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        calls === 2
          ? new Response("The service is busy.", { status: 503 })
          : answer()
      );
    };
    const { request, session, workspace } = await sofiaSession({
      modelFetch: withFalStorage(modelFetch),
    });
    await session.run(
      request({ providerKey: "test-key", strategy: "vector-model" })
    );
    expect(calls).toBe(2);
    const { activity, runs } = session.getState();
    expect(activity?.status).toBe("finished");
    const lines = activity?.lines ?? [];
    expect(lines.map((line) => [line.name, line.status])).toEqual([
      ["Light", "generated"],
      ["Regular", "failed"],
      ["ExtraBold", "not-run"],
    ]);
    const reason = lines[1]?.detail ?? "";
    expect(reason).toContain("503");
    const [run] = runs;
    expect(run?.members[1]).toMatchObject({ reason, status: "failed" });

    // Only the weight that made something is pinned, and it keeps its candidates.
    const { project } = workspace.getState();
    expect(
      project.faces.filter((face) => face.pinned).map(faceStyleName)
    ).toEqual(["Light"]);
    const made = run?.characters.filter(
      (character) => character.cells[0]?.candidate
    );
    expect(made?.length).toBeGreaterThan(0);
    expect(project.candidates).toHaveLength(made?.length ?? 0);
    for (const character of run?.characters ?? []) {
      expect(character.compatible).toBe(false);
      expect(character.cells[1]).toEqual({ missing: reason });
      expect(character.cells[2]).toEqual({
        missing: "Generation stopped before this weight.",
      });
    }
    expect(made?.[0]?.reason).toBe(`Regular has no candidate. ${reason}`);
  });

  it("keeps a run whose first weight failed, as a model run that made nothing", async () => {
    const { faceId, request, session, workspace } = await sofiaSession({
      modelFetch: () =>
        Promise.resolve(new Response("The service is busy.", { status: 503 })),
    });
    await session.run(
      request({ providerKey: "test-key", strategy: "vector-model" })
    );
    const { activity, runs } = session.getState();
    expect(activity?.faceId).toBe(faceId);
    expect(activity?.lines.map((line) => line.status)).toEqual([
      "failed",
      "not-run",
      "not-run",
    ]);
    const [run] = runs;
    // A call was made, so the run is never taken for one built by rule.
    expect(run?.strategy.kind).toBe("vector-model");
    expect(run?.strategy.name).toContain("ideogram/vector/text-to-vector");
    expect(run?.strategy.model).toBeUndefined();
    expect(
      run?.characters.every((character) =>
        character.cells.every((cell) => cell.candidate === undefined)
      )
    ).toBe(true);
    const { project } = workspace.getState();
    expect(project.faces).toHaveLength(1);
    expect(project.candidates).toEqual([]);
  });

  it("refuses to run without a key, in the strategy's own words", async () => {
    const { request, session, workspace } = await sofiaSession({
      modelFetch: () => Promise.reject(new Error("It must not be called.")),
    });
    await session.run(request({ strategy: "vector-model" }));
    expect(session.getState().activity?.failure).toContain("No fal API key");
    expect(workspace.getState().project.faces).toHaveLength(1);
  });

  it("proposes nothing when the run is stopped", async () => {
    const answer = await sheetResponse();
    let calls = 0;
    const stopping = await sofiaSession({
      modelFetch: withFalStorage((_input, init) => {
        calls += 1;
        if (calls === 2) {
          stopping.session.stop();
          return Promise.reject(init?.signal?.reason ?? new Error("Stopped."));
        }
        return Promise.resolve(answer());
      }),
    });
    await stopping.session.run(
      stopping.request({ providerKey: "test-key", strategy: "vector-model" })
    );
    expect(stopping.session.getState().activity).toEqual({
      faceId: stopping.faceId,
      failure:
        "The run was stopped before it finished, so nothing was proposed. Run again to start over.",
      lines: [],
      status: "failed",
    });
    expect(stopping.workspace.getState().project.candidates).toEqual([]);
    expect(stopping.workspace.getState().project.faces).toHaveLength(1);
  });
});
