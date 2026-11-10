import { describe, expect, it } from "vitest";
import {
  listRecordedCompletions,
  recordedAvailability,
  strategyOptions,
} from "~/reconstruct/completion";
import {
  missingFromAlphabet,
  typedCharacter,
  wantedCharacters,
} from "~/reconstruct/considered-characters";
import {
  chosenRecorded,
  DESTINATION_GONE,
  destinationStands,
} from "~/reconstruct/session";
import { outlineBounds } from "~/typeface/outline";
import { isUnconfirmed } from "~/typeface/provenance";
import { nodeImageCodec } from "../../scripts/generation/node-image-codec";
import {
  bannerSession,
  codeOf,
  fixtureFetch,
  HANDWRITING,
  STOREFRONT,
} from "./helpers/session";

const proposedBanner = async () => {
  const made = await bannerSession();
  made.session.setOptions({ considered: "capitals" });
  made.session.setDestination({ faceId: made.lato.faceId, kind: "existing" });
  await made.session.propose();
  return made;
};

const widthOf = (outline: Parameters<typeof outlineBounds>[0]) => {
  const bounds = outlineBounds(outline);
  return bounds ? bounds.xMax - bounds.xMin : 0;
};

describe("the characters asked for", () => {
  it("asks for the capitals the photograph does not show", () => {
    expect(missingFromAlphabet([..."NEDTHIGSFORAL"].map(codeOf))).toBe(
      "BCJKMPQUVWXYZ"
    );
  });

  it("asks for small letters too once one was observed", () => {
    expect(missingFromAlphabet([codeOf("A"), codeOf("b")])).toBe(
      "BCDEFGHIJKLMNOPQRSTUVWXYZacdefghijklmnopqrstuvwxyz"
    );
  });

  it("reads a typed list once each, in order, without spaces", () => {
    expect(wantedCharacters("B C B &")).toEqual([..."BC&"].map(codeOf));
  });

  it("takes the last character typed into a label", () => {
    expect(typedCharacter("0D")).toBe(codeOf("D"));
    expect(typedCharacter("  ")).toBeUndefined();
  });
});

describe("recorded runs for photographs", () => {
  it("lists only the runs that say which photograph they were made for", async () => {
    const { entries, problems } = await listRecordedCompletions(
      fixtureFetch,
      "/"
    );
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      directory: "2026-11-10-storefront-completion",
      evidenceFile: STOREFRONT,
    });
    expect(entries[0]?.targets.join("")).toBe("BCJKMPQUVWXYZ&?");
  });

  it("answers only for the photograph the model was shown", async () => {
    const { entries } = await listRecordedCompletions(fixtureFetch, "/");
    expect(recordedAvailability(entries[0], STOREFRONT)).toEqual({
      available: true,
    });
    expect(recordedAvailability(entries[0], HANDWRITING)).toEqual({
      available: false,
      reason:
        "This run was recorded for storefront-needed-things.jpg, not for handwriting-defg.jpg. Its letters follow that photograph's lettering.",
    });
    expect(recordedAvailability(undefined, STOREFRONT).available).toBe(false);
  });

  it("says a model cannot be called without a key, and never swaps it for another strategy", () => {
    const options = strategyOptions(
      { codec: nodeImageCodec, providerKey: " " },
      { available: true }
    );
    expect(options.map((option) => option.kind)).toEqual([
      "procedural",
      "recorded-run",
      "vector-model",
      "image-model",
    ]);
    expect(options.map((option) => option.availability.available)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const keyed = strategyOptions(
      { codec: nodeImageCodec, providerKey: "a-key" },
      { available: false, reason: "None." }
    );
    expect(keyed.map((option) => option.availability.available)).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });
});

describe("completing the alphabet", () => {
  it("replays the recorded run as inferred letters that say they were recorded", async () => {
    const { lato, session, workspace } = await proposedBanner();
    await session.listRecorded();
    expect(chosenRecorded(session.getState())?.evidenceFile).toBe(STOREFRONT);
    session.updateCompletionDraft({ strategy: "recorded-run" });
    await session.complete();
    const { completion, completionProblem } = session.getState();
    expect(completionProblem).toBeUndefined();
    expect(completion?.record).toMatchObject({
      model: "ideogram/vector/text-to-vector",
      recorded: true,
    });
    expect(completion?.wanted).toHaveLength(15);
    expect(completion?.candidates.length).toBeGreaterThan(10);
    for (const candidate of completion?.candidates ?? []) {
      expect(candidate.faceId).toBe(lato.faceId);
      expect(candidate.provenance).toMatchObject({
        basis: "inferred",
        origin: "reconstructed",
      });
      expect(isUnconfirmed(candidate.provenance)).toBe(true);
    }

    // The model drew wider than the banner's condensed letters.
    const ratio = completion?.inference.widths.ratio ?? 0;
    expect(ratio).toBeGreaterThan(1);
    const [wide] = completion?.candidates ?? [];
    session.narrow();
    const narrowed = session.getState().completion;
    expect(narrowed?.narrowedBy).toBeCloseTo(1 / ratio, 5);
    expect(
      widthOf(narrowed?.candidates[0]?.outline ?? { contours: [] })
    ).toBeLessThan(widthOf(wide?.outline ?? { contours: [] }));

    const before = workspace.getState().project.candidates.length;
    session.proposeInferred();
    expect(session.getState().completion?.proposed).toBe(true);
    expect(workspace.getState().project.candidates).toHaveLength(
      before + (narrowed?.candidates.length ?? 0)
    );
    // Once proposed, the letters are the project's and are not narrowed again.
    session.narrow();
    expect(session.getState().completion?.narrowedBy).toBe(
      narrowed?.narrowedBy
    );
  });

  it("reports what the procedural strategy could not draw instead of drawing it another way", async () => {
    const { session } = await proposedBanner();
    await session.complete();
    const { completion, completionProblem } = session.getState();
    expect(completionProblem).toBeUndefined();
    expect(completion?.record.recorded).toBe(false);
    expect(completion?.candidates).toEqual([]);
    expect(completion?.record.unmade.length).toBe(completion?.wanted.length);
    expect(completion?.record.unmade[0]?.reason).toBe(
      "No rule builds this glyph from existing ones. It needs a strategy that draws."
    );
  });

  it("names the missing key when a model is asked without one", async () => {
    const { session } = await proposedBanner();
    session.updateCompletionDraft({ strategy: "vector-model" });
    await session.complete();
    expect(session.getState().completion).toBeUndefined();
    expect(session.getState().completionProblem).toBe(
      "No fal API key was supplied, so this model cannot be called. Add a key to use it."
    );
  });

  it("sends one request to the model with the pasted key and marks what comes back as inferred, live", async () => {
    const calls: { readonly address: string; readonly key: string | null }[] =
      [];
    const sheet = await fixtureFetch(
      "/recorded-runs/2026-11-10-storefront-completion/ideogram-vector-medium.svg"
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
    const made = await bannerSession({ modelFetch });
    made.session.setOptions({ considered: "capitals" });
    made.session.setDestination({ faceId: made.lato.faceId, kind: "existing" });
    await made.session.propose();
    made.session.updateCompletionDraft({
      providerKey: "  test-key  ",
      strategy: "vector-model",
      wanted: "BCJKMPQUVWXYZ&?",
    });
    await made.session.complete();
    expect(calls).toEqual([
      {
        address: "https://fal.run/ideogram/vector/text-to-vector",
        key: "Key test-key",
      },
    ]);
    const { completion, completionProblem } = made.session.getState();
    expect(completionProblem).toBeUndefined();
    expect(completion?.record).toMatchObject({
      model: "ideogram/vector/text-to-vector",
      recorded: false,
    });
    expect(completion?.candidates.length).toBeGreaterThan(10);
    for (const candidate of completion?.candidates ?? []) {
      expect(candidate.provenance).toMatchObject({ basis: "inferred" });
    }
  });

  it("stops proposing and inferring once the destination face has left the project, in plain words", async () => {
    const { lato, session, workspace } = await proposedBanner();
    await session.listRecorded();
    session.updateCompletionDraft({ strategy: "recorded-run" });
    await session.complete();
    const inferred = session.getState().completion?.candidates.length ?? 0;
    expect(inferred).toBeGreaterThan(10);
    const { proposal } = session.getState();
    if (!proposal) {
      throw new Error("Nothing was proposed.");
    }
    expect(destinationStands(proposal, workspace.getState().project)).toBe(
      true
    );

    expect(workspace.removeSource(lato.sourceId, { force: true }).ok).toBe(
      true
    );
    expect(destinationStands(proposal, workspace.getState().project)).toBe(
      false
    );

    session.proposeInferred();
    expect(session.getState().completion?.proposed).toBe(false);
    expect(session.getState().completionProblem).toBe(DESTINATION_GONE);
    // No refusal from the project, so no notice with an internal id in it.
    expect(workspace.getState().notices).toEqual([]);

    session.updateCompletionDraft({ strategy: "procedural" });
    await session.complete();
    expect(session.getState().completion).toBeUndefined();
    expect(session.getState().completionProblem).toBe(DESTINATION_GONE);
    expect(DESTINATION_GONE).not.toContain(lato.faceId);
    expect(workspace.getState().notices).toEqual([]);

    // Choosing a destination again is the way out.
    session.reopen();
    expect(session.getState().proposal).toBeUndefined();
    expect(session.getState().completionProblem).toBeUndefined();
  });

  it("does nothing before letters were proposed to a face", async () => {
    const { session } = await bannerSession();
    await session.complete();
    expect(session.getState().completing).toBe(false);
    expect(session.getState().completion).toBeUndefined();
  });
});
