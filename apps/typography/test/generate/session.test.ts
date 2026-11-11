import { describe, expect, it } from "vitest";
import type { RunRequest } from "~/generate/running";
import { withFalStorage } from "../generation/helpers/fal";
import { codes, fixtureFetch, latoSession } from "./helpers/session";

const HOLDOUT_VECTOR = "2026-11-10-latin-holdout#vector-model";
const HOLDOUT_IMAGE = "2026-11-10-latin-holdout#image-model";
const DEVANAGARI = "2026-11-10-devanagari-subset#letters";
const STOREFRONT = "2026-11-10-storefront-completion#vector-model";

type CharactersRequest = Extract<RunRequest, { readonly kind: "characters" }>;

const accented = (faceId: string): CharactersRequest => ({
  characters: codes("éèñ"),
  faceId,
  kind: "characters",
  strategy: "procedural",
});

describe("a procedural holdout run", () => {
  it("redraws accented letters the face has and scores each against the face's own", async () => {
    const { faceId, session, workspace } = await latoSession();
    await session.run(accented(faceId));
    const { activity, runs, shownRunId } = session.getState();
    const [run] = runs;
    expect(activity?.status).toBe("finished");
    expect(shownRunId).toBe(run?.id);
    expect(run?.candidates.map(({ target }) => target.text)).toEqual([
      "é",
      "è",
      "ñ",
    ]);
    for (const reviewed of run?.candidates ?? []) {
      expect(reviewed.holdout).toBeDefined();
      expect(reviewed.evaluation.scores.shape).toBeGreaterThan(0.9);
      expect(reviewed.candidate.replaces?.kind).toBe("source");
      expect(reviewed.candidate.provenance).toMatchObject({
        origin: "generated",
        strategy: "procedural",
      });
      expect(reviewed.candidate.provenance).not.toHaveProperty("recorded");
      // The rule never read the glyph it is compared with.
      expect(reviewed.evaluation.madeBy).not.toContain(reviewed.target.text);
    }
    expect(
      workspace.getState().project.candidates.map(({ status }) => status)
    ).toEqual(["proposed", "proposed", "proposed"]);
  });

  it("records analyse and plan before the pipeline's own stages", async () => {
    const { faceId, session } = await latoSession();
    await session.run(accented(faceId));
    const [run] = session.getState().runs;
    expect(run?.outcomes.map(({ stage }) => stage)).toEqual([
      "analyse",
      "plan",
      "generate",
      "extract",
      "normalise",
      "compose",
      "validate",
      "refine",
      "integrate",
    ]);
    expect(run?.outcomes[1]?.detail).toBe(
      "3 targets planned, 3 under a holdout test."
    );
    expect(
      session.getState().activity?.board.map(({ status }) => status)
    ).toEqual([
      "finished",
      "finished",
      "finished",
      "skipped",
      "skipped",
      "finished",
      "finished",
      "finished",
      "finished",
    ]);
  });

  it("accepts a holdout candidate as a redrawing of the glyph, in one revision", async () => {
    const { faceId, session, workspace } = await latoSession();
    await session.run(accented(faceId));
    const [first] = session.getState().runs[0]?.candidates ?? [];
    expect(workspace.acceptCandidate(first?.candidate.id ?? "").ok).toBe(true);
    const { project } = workspace.getState();
    expect(project.head).toBe(1);
    expect(workspace.workingFace(faceId).added).toEqual([]);
    expect(workspace.workingFace(faceId).overrides.size).toBe(1);
  });

  it("accepts everything that passed and nothing else", async () => {
    const { faceId, session, workspace } = await latoSession();
    await session.run(accented(faceId));
    const [run] = session.getState().runs;
    const passed =
      run?.candidates.filter(
        ({ evaluation }) => evaluation.verdict === "pass"
      ) ?? [];
    expect(passed.length).toBeGreaterThan(0);
    expect(session.acceptPassed(run?.id ?? "")).toBe(passed.length);
    expect(workspace.getState().project.head).toBe(passed.length);
    // A second pass finds nothing left to accept.
    expect(session.acceptPassed(run?.id ?? "")).toBe(0);
  });

  it("regenerates one target, rejects the candidate it replaces and counts the attempt", async () => {
    const { faceId, session, workspace } = await latoSession();
    await session.run(accented(faceId));
    const [run] = session.getState().runs;
    const before = run?.candidates[1];
    await session.regenerate(run?.id ?? "", before?.target.key ?? "");
    const [after] = session.getState().runs;
    const again = after?.candidates[1];
    expect(again?.attempt).toBe(2);
    expect(again?.target.key).toBe(before?.target.key);
    expect(again?.candidate.id).not.toBe(before?.candidate.id);
    expect(after?.candidates).toHaveLength(3);
    expect(after?.regenerations.map(({ key }) => key)).toEqual(["u+00e8"]);
    const statuses = new Map(
      workspace
        .getState()
        .project.candidates.map(({ id, status }) => [id, status])
    );
    expect(statuses.get(before?.candidate.id ?? "")).toBe("rejected");
    expect(statuses.get(again?.candidate.id ?? "")).toBe("proposed");
  });

  it("keeps the earlier candidate when the regenerated one cannot be proposed", async () => {
    let issued = 0;
    const { faceId, session, workspace } = await latoSession({
      newId: () => {
        issued += 1;
        return `made-${issued}`;
      },
    });
    await session.run(accented(faceId));
    const [run] = session.getState().runs;
    const before = run?.candidates[1];
    // The same ids are issued again, so the project refuses the new candidate.
    issued = 0;
    await session.regenerate(run?.id ?? "", before?.target.key ?? "");

    const { activity, runs } = session.getState();
    expect(activity?.status).toBe("failed");
    expect(activity?.failure?.stage).toBe("integrate");
    expect(activity?.failure?.reason).toContain("was already proposed");
    // Nothing replaced it, so it still waits for a decision.
    expect(runs[0]?.candidates[1]?.candidate.id).toBe(before?.candidate.id);
    expect(
      workspace
        .getState()
        .project.candidates.find(({ id }) => id === before?.candidate.id)
        ?.status
    ).toBe("proposed");
    expect(workspace.getState().project.candidates).toHaveLength(3);
  });

  it("names the stage and the reason when the strategy cannot run", async () => {
    const { faceId, session, workspace } = await latoSession();
    await session.run({ ...accented(faceId), strategy: "vector-model" });
    const { activity, runs } = session.getState();
    expect(runs).toEqual([]);
    expect(activity?.status).toBe("failed");
    expect(activity?.failure?.stage).toBe("generate");
    expect(activity?.failure?.reason).toContain("No fal API key was supplied");
    expect(workspace.getState().project.candidates).toEqual([]);
  });

  it("says which targets no rule could build, and makes nothing for them", async () => {
    const { faceId, session } = await latoSession();
    await session.run({ ...accented(faceId), characters: [0x09_15] });
    const [run] = session.getState().runs;
    expect(run?.candidates).toEqual([]);
    expect(run?.record.unmade.map(({ key }) => key)).toEqual(["u+0915"]);
  });
});

describe("a model run with a pasted key", () => {
  it("sends one request to fal with the key and turns the sheet it gets back into candidates", async () => {
    const calls: { readonly address: string; readonly key: string | null }[] =
      [];
    const sheet = await fixtureFetch(
      "/recorded-runs/2026-11-10-latin-holdout/ideogram-vector-medium.svg"
    );
    const svg = await sheet.text();
    const modelFetch: typeof fetch = (input, init) => {
      calls.push({
        address: String(input),
        key: new Headers(init?.headers).get("Authorization"),
      });
      return Promise.resolve(
        Response.json({
          images: [
            {
              content_type: "image/svg+xml",
              url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
            },
          ],
        })
      );
    };
    const { faceId, session } = await latoSession({
      modelFetch: withFalStorage(modelFetch),
      providerKey: () => "  test-key  ",
    });
    await session.run({
      characters: codes("RGagk2"),
      faceId,
      kind: "characters",
      strategy: "vector-model",
    });
    expect(calls).toEqual([
      {
        address: "https://fal.run/ideogram/vector/text-to-vector",
        key: "Key test-key",
      },
    ]);
    const { activity, runs } = session.getState();
    expect(activity?.failure).toBeUndefined();
    const [run] = runs;
    expect(run?.record.recorded).toBe(false);
    expect(run?.record.model).toBe("ideogram/vector/text-to-vector");
    expect(run?.record.costUsd).toBeUndefined();
    expect(run?.sent?.prompt).toContain("Draw one glyph sheet");
    expect(run?.candidates.length).toBeGreaterThan(0);
  });
});

describe("a recorded run", () => {
  it("lists every output of every served run, with what each was made from", async () => {
    const { session } = await latoSession();
    await session.listRecorded();
    const { catalogue, draft } = session.getState();
    if (catalogue.status !== "listed") {
      throw new Error("The recorded runs were not listed.");
    }
    expect(catalogue.catalogue.problems).toEqual([]);
    expect(catalogue.catalogue.entries.map(({ id }) => id)).toEqual([
      DEVANAGARI,
      "2026-11-10-devanagari-subset#syllables",
      HOLDOUT_IMAGE,
      HOLDOUT_VECTOR,
      STOREFRONT,
    ]);
    const made = new Map(
      catalogue.catalogue.entries.map(({ id, madeFrom }) => [id, madeFrom])
    );
    expect(made.get(HOLDOUT_VECTOR)).toEqual({
      family: "Lato",
      style: "Regular",
    });
    expect(made.get(STOREFRONT)).toBeUndefined();
    expect(draft.recordedId).toBe(DEVANAGARI);
  });

  it.each([
    [HOLDOUT_VECTOR, "vector-model", "ideogram/vector/text-to-vector"],
    [HOLDOUT_IMAGE, "image-model", "openai/gpt-image-2.6/flare/edit"],
  ])(
    "replays %s as six recorded candidates compared with Lato's own",
    async (entryId, strategy, model) => {
      const { faceId, session, workspace } = await latoSession();
      await session.listRecorded();
      await session.run({ entryId, faceId, kind: "recorded" });
      const { activity, runs } = session.getState();
      expect(activity?.failure).toBeUndefined();
      const [run] = runs;
      expect(run?.record).toMatchObject({ model, recorded: true });
      expect(run?.record.costUsd).toBeUndefined();
      expect(run?.candidates.map(({ target }) => target.text)).toEqual([
        "R",
        "G",
        "a",
        "g",
        "k",
        "2",
      ]);
      for (const { candidate, evaluation, holdout } of run?.candidates ?? []) {
        expect(candidate.provenance).toMatchObject({
          model,
          origin: "generated",
          recorded: true,
          strategy,
        });
        expect(holdout).toBeDefined();
        expect(evaluation.scores.shape).toBeGreaterThan(0.5);
        expect(evaluation.scores.shape).toBeLessThan(1);
      }
      const [first] = run?.candidates ?? [];
      expect(workspace.acceptCandidate(first?.candidate.id ?? "").ok).toBe(
        true
      );
      expect(workspace.getState().project.head).toBe(1);
    }
  );

  it("gives no agreement score to a run that was not made from the chosen face", async () => {
    const { faceId, session } = await latoSession();
    await session.listRecorded();
    await session.run({ entryId: STOREFRONT, faceId, kind: "recorded" });
    const [run] = session.getState().runs;
    expect(run?.candidates.length).toBeGreaterThan(0);
    for (const { evaluation, holdout } of run?.candidates ?? []) {
      expect(holdout).toBeUndefined();
      expect(evaluation.scores.shape).toBeUndefined();
    }
  });

  it("adds glyphs for characters the face lacks, and redraws them when replayed after one is accepted", async () => {
    const { faceId, session, workspace } = await latoSession();
    await session.listRecorded();
    await session.run({ entryId: DEVANAGARI, faceId, kind: "recorded" });
    const [first] = session.getState().runs[0]?.candidates ?? [];
    expect(first?.candidate.replaces).toBeUndefined();
    expect(workspace.acceptCandidate(first?.candidate.id ?? "").ok).toBe(true);
    await session.run({ entryId: DEVANAGARI, faceId, kind: "recorded" });
    const [again] = session.getState().runs[0]?.candidates ?? [];
    expect(again?.target.key).toBe(first?.target.key);
    expect(again?.candidate.replaces).toEqual({
      key: first?.candidate.id,
      kind: "added",
    });
    expect(workspace.acceptCandidate(again?.candidate.id ?? "").ok).toBe(true);
    expect(workspace.workingFace(faceId).added).toHaveLength(1);
  });

  it("fails at plan when no recorded run is chosen", async () => {
    const { faceId, session } = await latoSession();
    await session.run({ entryId: "", faceId, kind: "recorded" });
    expect(session.getState().activity?.failure).toEqual({
      reason:
        "No recorded run is chosen. Choose one from the list, then run again.",
      stage: "plan",
    });
  });
});
