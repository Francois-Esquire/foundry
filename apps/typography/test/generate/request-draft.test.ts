import { expect, it } from "vitest";
import { withoutCharacters } from "~/generate/hidden-characters";
import {
  namedCharacters,
  readinessOf,
  recordedAvailability,
  requestOf,
  ruleSummary,
} from "~/generate/request-draft";
import { charactersToAsk, planRequest } from "~/generate/request-plan";
import type { Draft } from "~/generate/session";
import { latoSession } from "./helpers/session";

const draft: Draft = {
  language: "test",
  recordedId: "",
  scope: "script:Latn",
  source: "typed",
  strategy: "vector-model",
  typed: "éèé",
};
const language = {
  auxiliary: new Uint32Array([0xf1]),
  name: "Test",
  required: new Uint32Array([0xe9, 0xe8]),
  script: "Latn",
  tag: "test",
};
const classify = (character: number) =>
  character === 0xe9 ? ("source" as const) : ("missing" as const);

it.each(["typed", "language", "script"] as const)(
  "builds a %s request from the draft",
  async (source) => {
    const chosen = { ...draft, source };
    const { workspace, faceId } = await latoSession();
    const face = workspace
      .getState()
      .project.faces.find((known) => known.id === faceId);
    if (!face) {
      throw new Error("Missing face");
    }
    const named = namedCharacters(
      chosen,
      (character) => ([0xe9, 0xe8].includes(character) ? "missing" : "source"),
      [language]
    );
    const plan = planRequest(workspace.openFace(faceId), named, (character) =>
      workspace.glyphForCharacter(faceId, character)
    );
    expect(named).toEqual(source === "script" ? [0xe8, 0xe9] : [0xe9, 0xe8]);
    expect(
      readinessOf(
        undefined,
        requestOf(face, chosen, named, plan, undefined),
        chosen,
        0
      )
    ).toEqual({ ready: true });
    expect(requestOf(face, chosen, named, plan, undefined)).toEqual({
      characters: named,
      faceId,
      kind: "characters",
      strategy: "vector-model",
    });
  }
);

it("names missing language characters in exemplar order", () => {
  expect(
    namedCharacters({ ...draft, source: "language" }, classify, [language])
  ).toEqual([0xe8, 0xf1]);
});

it("names missing script characters from the classification", () => {
  expect(
    namedCharacters(
      { ...draft, source: "script" },
      (character) => (character === 0xe8 ? "missing" : "source"),
      undefined
    )
  ).toEqual([0xe8]);
});

it("filters a procedural language request to characters a rule can build", async () => {
  const { workspace, faceId } = await latoSession();
  const chosen = {
    ...draft,
    source: "language" as const,
    strategy: "procedural" as const,
  };
  const named = namedCharacters(chosen, () => "missing", [
    {
      ...language,
      auxiliary: new Uint32Array(),
      required: new Uint32Array([0xe9, 0x9_15]),
    },
  ]);
  expect(
    charactersToAsk(
      withoutCharacters(workspace.openFace(faceId), [0xe9]),
      named,
      chosen
    )
  ).toEqual({ characters: [0xe9], noRule: 1 });
});

it("builds a chosen replay and makes it available", async () => {
  const { workspace, faceId, session } = await latoSession();
  await session.listRecorded();
  const state = session.getState();
  if (state.catalogue.status !== "listed") {
    throw new Error("Missing catalogue");
  }
  const [entry] = state.catalogue.catalogue.entries;
  if (!entry) {
    throw new Error("Missing entry");
  }
  const face = workspace
    .getState()
    .project.faces.find((known) => known.id === faceId);
  if (!face) {
    throw new Error("Missing face");
  }
  const plan = planRequest(workspace.openFace(faceId), [], () => undefined);
  expect(recordedAvailability(state.catalogue, true)).toEqual({
    available: true,
  });
  expect(
    requestOf(face, { ...draft, strategy: "recorded-run" }, [], plan, entry)
  ).toEqual({ entry, faceId, kind: "recorded" });
  expect(recordedAvailability(state.catalogue, false)).toEqual({
    available: false,
    reason: "Choose a recorded run to replay.",
  });
});

it("explains an empty catalogue, a failed listing and a listing in progress", () => {
  expect(
    recordedAvailability(
      { catalogue: { entries: [], problems: [] }, status: "listed" },
      false
    )
  ).toEqual({
    available: false,
    reason: "No recorded run is served with this app.",
  });
  expect(
    recordedAvailability({ reason: "Offline", status: "failed" }, false)
  ).toEqual({
    available: false,
    reason: "The recorded runs could not be listed.",
  });
  expect(recordedAvailability({ status: "loading" }, false)).toEqual({
    available: false,
    reason: "The recorded runs are being listed.",
  });
});

it("explains an unavailable strategy and an empty request", async () => {
  const { workspace, faceId, session } = await latoSession();
  const face = workspace
    .getState()
    .project.faces.find((known) => known.id === faceId);
  if (!face) {
    throw new Error("Missing face");
  }
  const plan = planRequest(workspace.openFace(faceId), [], () => undefined);
  const request = requestOf(face, draft, [], plan, undefined);
  expect(request).toBeUndefined();
  expect(readinessOf(undefined, request, draft, 0)).toEqual({
    ready: false,
    reason: "Type the characters to generate.",
  });
  const option = session
    .strategyOptions({ available: false, reason: "Choose a run." })
    .find(({ kind }) => kind === "vector-model");
  expect(
    readinessOf(
      option,
      {
        characters: [0xe9],
        faceId,
        kind: "characters",
        strategy: "vector-model",
      },
      draft,
      0
    )
  ).toEqual({
    ready: false,
    reason:
      "No fal API key was supplied, so this model cannot be called. Add a key to use it.",
  });
});

it("summarises no targets, ruled targets and targets that need drawing", () => {
  expect(ruleSummary(0, 0)).toBe(
    "Choose characters above to see which of them a rule can build."
  );
  expect(ruleSummary(1, 1)).toBe(
    "A rule can build this target from glyphs the face has."
  );
  expect(ruleSummary(2, 2)).toBe(
    "A rule can build all 2 targets from glyphs the face has."
  );
  expect(ruleSummary(1, 2)).toBe(
    "A rule can build 1 of the 2 targets. The others have to be drawn, and the run says so for each."
  );
});
